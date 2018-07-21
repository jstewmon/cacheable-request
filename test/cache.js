import { request } from 'http';
import url from 'url';
import util from 'util';
import test from 'ava';
import getStream from 'get-stream';
import createTestServer from 'create-test-server';
import delay from 'delay';
import sqlite3 from 'sqlite3';
import pify from 'pify';
import CacheableRequest from 'this';

let s;

// Promisify cacheableRequest
const promisify = cacheableRequest => opts => new Promise((resolve, reject) => {
	cacheableRequest(opts, async response => {
		const body = await getStream(response);
		response.body = body;
		resolve(response);
	})
		.on('request', req => req.end())
		.once('error', reject);
});

test.before('setup', async () => {
	s = await createTestServer();

	let noStoreIndex = 0;
	s.get('/no-store', (req, res) => {
		noStoreIndex++;
		res.setHeader('Cache-Control', 'public, no-cache, no-store');
		res.end(noStoreIndex.toString());
	});

	let cacheIndex = 0;
	s.get('/cache', (req, res) => {
		cacheIndex++;
		res.setHeader('Cache-Control', 'public, max-age=60');
		res.end(cacheIndex.toString());
	});

	s.get('/last-modified', (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=0');
		res.setHeader('Last-Modified', 'Wed, 21 Oct 2015 07:28:00 GMT');
		let responseBody = 'last-modified';

		if (req.headers['if-modified-since'] === 'Wed, 21 Oct 2015 07:28:00 GMT') {
			res.statusCode = 304;
			responseBody = null;
		}

		res.end(responseBody);
	});

	s.get('/etag', (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=0');
		res.setHeader('ETag', '33a64df551425fcc55e4d42a148795d9f25f89d4');
		let responseBody = 'etag';

		if (req.headers['if-none-match'] === '33a64df551425fcc55e4d42a148795d9f25f89d4') {
			res.statusCode = 304;
			responseBody = null;
		}

		res.end(responseBody);
	});

	s.get('/revalidate-modified', (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=0');
		res.setHeader('ETag', '33a64df551425fcc55e4d42a148795d9f25f89d4');
		let responseBody = 'revalidate-modified';

		if (req.headers['if-none-match'] === '33a64df551425fcc55e4d42a148795d9f25f89d4') {
			res.setHeader('ETag', '0000000000000000000000000000000000');
			responseBody = 'new-body';
		}

		res.end(responseBody);
	});

	s.get('/etag-cache-1s', (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=1');
		res.setHeader('ETag', '33a64df551425fcc55e4d42a148795d9f25f89d4');
		let responseBody = 'etag-cache-1s';

		if (req.headers['if-none-match'] === '33a64df551425fcc55e4d42a148795d9f25f89d4') {
			res.statusCode = 304;
			responseBody = null;
		}

		res.end(responseBody);
	});

	let cacheThenNoStoreIndex = 0;
	s.get('/cache-then-no-store-on-revalidate', (req, res) => {
		const cc = cacheThenNoStoreIndex === 0 ? 'public, max-age=0' : 'public, no-cache, no-store';
		cacheThenNoStoreIndex++;
		res.setHeader('Cache-Control', cc);
		res.end('cache-then-no-store-on-revalidate');
	});

	s.get('/echo', (req, res) => {
		const { headers, query, path, originalUrl, body } = req;
		res.json({
			headers,
			query,
			path,
			originalUrl,
			body
		});
	});

	await s.listen(s.port);
});

test('Non cacheable responses are not cached', async t => {
	const endpoint = '/no-store';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);

	const firstResponseInt = Number((await cacheableRequestHelper(s.url + endpoint)).body);
	const secondResponseInt = Number((await cacheableRequestHelper(s.url + endpoint)).body);

	t.is(cache.size, 0);
	t.true(firstResponseInt < secondResponseInt);
});

test('Cacheable responses are cached', async t => {
	const endpoint = '/cache';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);

	const firstResponse = await cacheableRequestHelper(s.url + endpoint);
	const secondResponse = await cacheableRequestHelper(s.url + endpoint);

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
});

test('Cacheable responses have unique cache key', async t => {
	const endpoint = '/cache';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);

	const firstResponse = await cacheableRequestHelper(s.url + endpoint + '?foo');
	const secondResponse = await cacheableRequestHelper(s.url + endpoint + '?bar');

	t.is(cache.size, 2);
	t.not(firstResponse.body, secondResponse.body);
});

async function testCacheKey(t, input, expected) {
	const expectKey = `cacheable-request:${expected}`;
	const okMessage = `OK ${expectKey}`;
	const cache = {
		get(key) {
			t.is(key, expectKey);
			throw new Error(okMessage);
		}
	};
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);
	await t.throws(
		cacheableRequestHelper(input),
		CacheableRequest.CacheError,
		okMessage
	);
}
testCacheKey.title = (providedTitle, input) => util.format(
	'Cache key is http.request compatible for arg %s(%j)%s',
	input.constructor.name,
	input,
	providedTitle ? ` (${providedTitle})` : ''
);
test(
	testCacheKey,
	'http://www.example.com',
	'GET:http://www.example.com'
);
test(
	'strips default path',
	testCacheKey,
	'http://www.example.com/',
	'GET:http://www.example.com'
);
test(
	'keeps trailing /',
	testCacheKey,
	'http://www.example.com/test/',
	'GET:http://www.example.com/test/'
);
test(
	testCacheKey,
	new url.URL('http://www.example.com'),
	'GET:http://www.example.com'
);
test(
	'no requried properties',
	testCacheKey,
	{},
	'GET:http://localhost'
);
test(
	testCacheKey,
	{
		protocol: 'http:',
		host: 'www.example.com',
		port: 80,
		path: '/'
	},
	'GET:http://www.example.com'
);
test(
	testCacheKey,
	{
		hostname: 'www.example.com',
		port: 80,
		path: '/'
	},
	'GET:http://www.example.com'
);
test(
	testCacheKey,
	{
		hostname: 'www.example.com',
		port: 8080,
		path: '/'
	},
	'GET:http://www.example.com:8080'
);
test(
	testCacheKey,
	{ host: 'www.example.com' },
	'GET:http://www.example.com'
);
test(
	'hostname over host',
	testCacheKey,
	{
		host: 'www.example.com',
		hostname: 'xyz.example.com'
	},
	'GET:http://xyz.example.com'
);
test(
	'hostname defaults to localhost',
	testCacheKey,
	{ path: '/' },
	'GET:http://localhost'
);
test(
	'ignores pathname',
	testCacheKey,
	{
		path: '/foo',
		pathname: '/bar'
	},
	'GET:http://localhost/foo'
);
test(
	'ignores search',
	testCacheKey,
	{
		path: '/?foo=bar',
		search: '?bar=baz'
	},
	'GET:http://localhost/?foo=bar'
);
test(
	'ignores query',
	testCacheKey,
	{
		path: '/?foo=bar',
		query: { bar: 'baz' }
	},
	'GET:http://localhost/?foo=bar'
);
test(
	testCacheKey,
	{ auth: 'user:pass' },
	'GET:http://user:pass@localhost'
);
test(
	testCacheKey,
	{ method: 'POST' },
	'POST:http://localhost'
);

test('request options path query is passed through', async t => {
	const cacheableRequest = new CacheableRequest(request);
	const cacheableRequestHelper = promisify(cacheableRequest);
	const argString = `${s.url}/echo?foo=bar`;
	const argURL = new url.URL(argString);
	const urlObject = url.parse(argString);
	const argOptions = {
		hostname: urlObject.hostname,
		port: urlObject.port,
		path: urlObject.path
	};
	const inputs = [argString, argURL, argOptions];
	for (const input of inputs) {
		// eslint-disable-next-line no-await-in-loop
		const response = await cacheableRequestHelper(input);
		const body = JSON.parse(response.body);
		const message = util.format(
			'when request arg is %s(%j)',
			input.constructor.name,
			input
		);
		t.is(body.query.foo, 'bar', message);
	}
});

test('Setting opts.cache to false bypasses cache for a single request', async t => {
	const endpoint = '/cache';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);
	const opts = url.parse(s.url + endpoint);
	const optsNoCache = Object.assign({ cache: false }, opts);

	const firstResponse = await cacheableRequestHelper(opts);
	const secondResponse = await cacheableRequestHelper(opts);
	const thirdResponse = await cacheableRequestHelper(optsNoCache);
	const fourthResponse = await cacheableRequestHelper(opts);

	t.false(firstResponse.fromCache);
	t.true(secondResponse.fromCache);
	t.false(thirdResponse.fromCache);
	t.true(fourthResponse.fromCache);
});

test('TTL is passed to cache', async t => {
	const endpoint = '/cache';
	const store = new Map();
	const cache = {
		get: store.get.bind(store),
		set: (key, val, ttl) => {
			t.true(typeof ttl === 'number');
			t.true(ttl > 0);
			return store.set(key, val, ttl);
		},
		delete: store.delete.bind(store)
	};
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);
	const opts = Object.assign({ strictTtl: true }, url.parse(s.url + endpoint));

	t.plan(2);

	await cacheableRequestHelper(opts);
});

test('TTL is not passed to cache if strictTtl is false', async t => {
	const endpoint = '/cache';
	const store = new Map();
	const cache = {
		get: store.get.bind(store),
		set: (key, val, ttl) => {
			t.true(typeof ttl === 'undefined');
			return store.set(key, val, ttl);
		},
		delete: store.delete.bind(store)
	};
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);
	const opts = Object.assign({ strictTtl: false }, url.parse(s.url + endpoint));

	t.plan(1);

	await cacheableRequestHelper(opts);
});

test('Stale cache entries with Last-Modified headers are revalidated', async t => {
	const endpoint = '/last-modified';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);

	const firstResponse = await cacheableRequestHelper(s.url + endpoint);
	const secondResponse = await cacheableRequestHelper(s.url + endpoint);

	t.is(cache.size, 1);
	t.is(firstResponse.statusCode, 200);
	t.is(secondResponse.statusCode, 304);
	t.is(firstResponse.body, 'last-modified');
	t.is(firstResponse.body, secondResponse.body);
});

test('Stale cache entries with ETag headers are revalidated', async t => {
	const endpoint = '/etag';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);

	const firstResponse = await cacheableRequestHelper(s.url + endpoint);
	const secondResponse = await cacheableRequestHelper(s.url + endpoint);

	t.is(cache.size, 1);
	t.is(firstResponse.statusCode, 200);
	t.is(secondResponse.statusCode, 304);
	t.is(firstResponse.body, 'etag');
	t.is(firstResponse.body, secondResponse.body);
});

test('Stale cache entries that can\'t be revalidate are deleted from cache', async t => {
	const endpoint = '/cache-then-no-store-on-revalidate';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);

	const firstResponse = await cacheableRequestHelper(s.url + endpoint);
	t.is(cache.size, 1);
	const secondResponse = await cacheableRequestHelper(s.url + endpoint);

	t.is(cache.size, 0);
	t.is(firstResponse.statusCode, 200);
	t.is(secondResponse.statusCode, 200);
	t.is(firstResponse.body, 'cache-then-no-store-on-revalidate');
	t.is(firstResponse.body, secondResponse.body);
});

test('Response objects have fromCache property set correctly', async t => {
	const endpoint = '/cache';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);

	const response = await cacheableRequestHelper(s.url + endpoint);
	const cachedResponse = await cacheableRequestHelper(s.url + endpoint);

	t.false(response.fromCache);
	t.true(cachedResponse.fromCache);
});

test('Revalidated responses that are re-cached return 304 but 200 on subsequent cache responses', async t => {
	const endpoint = '/etag-cache-1s';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);

	const firstResponse = await cacheableRequestHelper(s.url + endpoint);
	await delay(1100);
	const secondResponse = await cacheableRequestHelper(s.url + endpoint);
	const thirdResponse = await cacheableRequestHelper(s.url + endpoint);

	t.is(firstResponse.statusCode, 200);
	t.false(firstResponse.fromCache);
	t.is(secondResponse.statusCode, 304);
	t.true(secondResponse.fromCache);
	t.is(thirdResponse.statusCode, 200);
	t.true(thirdResponse.fromCache);
});

test('Revalidated responses that are modified are passed through', async t => {
	const endpoint = '/revalidate-modified';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);

	const firstResponse = await cacheableRequestHelper(s.url + endpoint);
	const secondResponse = await cacheableRequestHelper(s.url + endpoint);

	t.is(firstResponse.statusCode, 200);
	t.is(secondResponse.statusCode, 200);
	t.is(firstResponse.body, 'revalidate-modified');
	t.is(secondResponse.body, 'new-body');
});

test('Undefined callback parameter inside cache logic is handled', async t => {
	const endpoint = '/cache';
	const cache = new Map();
	const cacheableRequest = new CacheableRequest(request, cache);
	const cacheableRequestHelper = promisify(cacheableRequest);

	await cacheableRequestHelper(s.url + endpoint);
	cacheableRequest(s.url + endpoint);
	await delay(500);
	t.pass();
});

test('Keyv cache adapters load via connection uri', async t => {
	const endpoint = '/cache';
	const cacheableRequest = new CacheableRequest(request, 'sqlite://test/testdb.sqlite');
	const cacheableRequestHelper = promisify(cacheableRequest);
	const db = new sqlite3.Database('test/testdb.sqlite');
	const query = pify(db.all).bind(db);

	const firstResponse = await cacheableRequestHelper(s.url + endpoint);
	await delay(1000);
	const secondResponse = await cacheableRequestHelper(s.url + endpoint);
	const cacheResult = await query(`SELECT * FROM keyv WHERE "key" = "cacheable-request:GET:${s.url + endpoint}"`);

	t.false(firstResponse.fromCache);
	t.true(secondResponse.fromCache);
	t.is(cacheResult.length, 1);

	await query(`DELETE FROM keyv`);
});

test.after('cleanup', async () => {
	await s.close();
});
