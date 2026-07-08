/**
 * Manual smoke test: calls the compiled Framer node's execute() directly
 * against the real Framer Server API, without going through n8n's UI.
 * Requires .env.test (copy .env.test.example) with FRAMER_PROJECT_URL and
 * FRAMER_API_KEY. Read-only by default (project.getInfo + siteManager
 * readStructure) so it's safe to run against a real project.
 *
 * Usage: node scripts/smoke-test.js
 */
const fs = require('fs');
const path = require('path');

function loadEnvFile(file) {
	if (!fs.existsSync(file)) return;
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (!(key in process.env)) process.env[key] = value;
	}
}

loadEnvFile(path.join(__dirname, '..', '.env.test'));

const projectUrl = process.env.FRAMER_PROJECT_URL;
const apiKey = process.env.FRAMER_API_KEY;

if (!projectUrl || !apiKey) {
	console.error('Missing FRAMER_PROJECT_URL or FRAMER_API_KEY. Copy .env.test.example to .env.test and fill it in.');
	process.exit(1);
}

const { Framer } = require('../dist/index.js');

// Minimal stand-in for n8n's IExecuteFunctions, just enough for execute().
function makeContext(items, paramsPerItem) {
	return {
		getInputData: () => items,
		getNodeParameter: (name, i) => paramsPerItem[i][name],
		getCredentials: async () => ({ projectUrl, apiKey }),
		continueOnFail: () => false,
		getNode: () => ({ name: 'Framer (smoke test)' }),
	};
}

async function run(label, params) {
	const node = new Framer();
	const ctx = makeContext([{ json: {} }], [params]);
	console.log(`\n=== ${label} ===`);
	try {
		const [result] = await node.execute.call(ctx);
		console.log(JSON.stringify(result[0].json, null, 2).slice(0, 2000));
	} catch (err) {
		console.error('FAILED:', err.message);
		process.exitCode = 1;
	}
}

(async () => {
	await run('Project > Get Info', { resource: 'project', operation: 'getInfo' });
	await run('Collection > Get Many', { resource: 'collection', operation: 'getMany' });
	await run('Site Manager > Read Structure', {
		resource: 'siteManager',
		operation: 'readStructure',
		siteManagerInput: '{}',
	});
})();
