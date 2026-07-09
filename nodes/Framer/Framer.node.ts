import {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';
import type { Collection, Framer as FramerClient } from 'framer-api';

interface FramerApiCredentials {
	projectUrl: string;
	apiKey: string;
}

/**
 * framer-api ships ESM-only ("type": "module"), while this node compiles to
 * CommonJS like the rest of n8n. A static `import` would be rewritten to
 * `require()` by tsc and crash at runtime with ERR_REQUIRE_ESM, so the
 * connector is loaded through a dynamic `import()` that tsc cannot downlevel.
 */
async function loadFramerConnect(): Promise<
	(projectUrl: string, apiKey: string) => Promise<FramerClient>
> {
	const dynamicImport = new Function('m', 'return import(m)') as (
		m: string,
	) => Promise<{ connect: (projectUrl: string, apiKey: string) => Promise<FramerClient> }>;
	const mod = await dynamicImport('framer-api');
	return mod.connect;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Item IDs are declared as a plain 'string' field, but n8n does not coerce
 * expression-resolved values to match a field's declared type — an
 * expression like {{ $json.ids }} pointing at an array is passed through
 * as-is, so a plain .split(',') on it throws. Accept both shapes.
 */
function parseIdList(input: unknown): string[] {
	if (Array.isArray(input)) {
		return input.map((v) => String(v).trim()).filter(Boolean);
	}
	return String(input ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseJsonArray(input: unknown, label: string, ctx: IExecuteFunctions): IDataObject[] {
	let parsed = input;
	if (typeof input === 'string') {
		try {
			parsed = JSON.parse(input);
		} catch (err) {
			throw new NodeOperationError(ctx.getNode(), `${label} is not valid JSON: ${getErrorMessage(err)}`);
		}
	}
	if (!Array.isArray(parsed)) {
		throw new NodeOperationError(ctx.getNode(), `${label} must be a JSON array`);
	}
	return parsed as IDataObject[];
}

async function getCollectionById(
	framer: FramerClient,
	id: string,
	ctx: IExecuteFunctions,
): Promise<Collection> {
	const all = await framer.getCollections();
	const found = all.find((c) => c.id === id);
	if (!found) {
		throw new NodeOperationError(ctx.getNode(), `Collection not found: ${id}`);
	}
	return found;
}

/**
 * Compound "Site Manager" resource: bundles multi-step read/audit/write
 * flows behind a single v4-webhook-compatible JSON payload, so existing
 * webhook-based automations can be pointed at this node with no payload
 * changes.
 */
async function runSiteManager(
	framer: FramerClient,
	operation: string,
	data: IDataObject,
	ctx: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject> {
	const result: IDataObject = { success: true, action: operation };
	const getCollections = async () => framer.getCollections();
	const findCollection = async (nameSubstr: unknown) => {
		const all = await getCollections();
		const tgt = String(nameSubstr ?? '').toLowerCase();
		return all.find((c) => (c.name || '').toLowerCase().includes(tgt));
	};

	if (operation === 'readStructure') {
		const cols = await getCollections();
		const details: IDataObject[] = [];
		for (const col of cols) {
			let fields: IDataObject[] = [];
			let items: IDataObject[] = [];
			try {
				fields = (await col.getFields()) as unknown as IDataObject[];
			} catch (e) {
				fields = [{ error: getErrorMessage(e) }];
			}
			try {
				items = (await col.getItems()) as unknown as IDataObject[];
			} catch {
				items = [];
			}
			details.push({
				name: col.name,
				id: col.id,
				slug: (col as unknown as IDataObject).slug,
				itemCount: Array.isArray(items) ? items.length : 0,
				fields: Array.isArray(fields)
					? fields.map((f) => ({ name: f.name, type: f.type, id: f.id }))
					: fields,
			});
		}
		result.collections = details;
	} else if (operation === 'readPages') {
		const paths = data.path ? [data.path] : ((data.paths as unknown[]) || []);
		const cols = await getCollections();
		const pages: IDataObject[] = [];
		for (const col of cols) {
			const items = (await col.getItems()) as unknown as IDataObject[];
			for (const it of items) {
				const slug = (it.slug as string) || '';
				const match =
					paths.length === 0 ||
					paths.some(
						(p) =>
							p === '/' + slug ||
							p === slug ||
							slug.includes(String(p).replace('/', '')),
					);
				if (match) {
					pages.push({ collection: col.name, slug: it.slug, id: it.id, fieldData: it.fieldData || it });
				}
			}
		}
		result.pages = pages;
		if (pages.length === 0) result.note = 'No CMS items found.';
	} else if (operation === 'readCms') {
		const col = await findCollection(data.collection);
		if (col) {
			const items = (await col.getItems()) as unknown as IDataObject[];
			const fields = (await col.getFields()) as unknown as IDataObject[];
			result.collection = {
				name: col.name,
				id: col.id,
				fields: (Array.isArray(fields) ? fields : []).map((f) => f.name),
			};
			result.items = items.map((it) => ({ slug: it.slug, id: it.id, fieldData: it.fieldData || it }));
		} else {
			const all = await getCollections();
			result.error = 'Collection not found.';
			result.availableCollections = all.map((c) => c.name);
		}
	} else if (operation === 'readCmsItem') {
		const col = await findCollection(data.collection);
		if (col) {
			const items = (await col.getItems()) as unknown as IDataObject[];
			const found = items.find((i) => i.slug === data.slug);
			if (found) {
				result.item = { slug: found.slug, id: found.id, fieldData: found.fieldData || found };
			} else {
				result.error = 'Item not found.';
				result.availableSlugs = items.map((i) => i.slug);
			}
		} else {
			result.error = 'Collection not found.';
		}
	} else if (operation === 'auditSeo') {
		const cols = await getCollections();
		const issues: IDataObject[] = [];
		const audits: IDataObject[] = [];
		for (const col of cols) {
			const items = (await col.getItems()) as unknown as IDataObject[];
			const fields = (await col.getFields()) as unknown as IDataObject[];
			const fnames = (Array.isArray(fields) ? fields : []).map((f) =>
				((f.name as string) || '').toLowerCase(),
			);
			const hasMT = fnames.some((f) => f.includes('meta') && f.includes('title'));
			const hasMD = fnames.some((f) => f.includes('meta') && f.includes('desc'));
			for (const it of items) {
				const fd = (it.fieldData as IDataObject) || {};
				const aud: IDataObject = { collection: col.name, slug: it.slug };
				const mt = (fd['meta-title'] || fd['metaTitle'] || fd['meta_title']) as string | undefined;
				if (mt) {
					aud.meta_title = mt;
					if (mt.length > 60) issues.push({ slug: it.slug, issue: 'meta_title_too_long', severity: 'medium' });
				} else if (hasMT) {
					issues.push({ slug: it.slug, issue: 'meta_title_missing', severity: 'high' });
				}
				const md = (fd['meta-description'] || fd['metaDescription'] || fd['meta_description']) as
					| string
					| undefined;
				if (md) {
					aud.meta_description = md;
					if (md.length > 160) issues.push({ slug: it.slug, issue: 'meta_desc_too_long', severity: 'medium' });
				} else if (hasMD) {
					issues.push({ slug: it.slug, issue: 'meta_desc_missing', severity: 'high' });
				}
				aud.fieldData = fd;
				audits.push(aud);
			}
		}
		result.audit = { total_items: audits.length, total_issues: issues.length, issues, items: audits };
	} else if (operation === 'readChanges') {
		result.changes = (await framer.getChangedPaths()) as unknown as IDataObject;
	} else if (operation === 'updatePages') {
		const pagesInput = (data.pages as IDataObject[]) || [];
		const cols = await getCollections();
		const pgCol = cols.find((c) => {
			const n = (c.name || '').toLowerCase();
			return n.includes('page') || n.includes('pagina') || n.includes('landing');
		});
		const updates: IDataObject[] = [];
		if (!pgCol) {
			updates.push({ error: 'pages collection not found' });
		} else {
			const items = (await pgCol.getItems()) as unknown as IDataObject[];
			for (const pg of pagesInput) {
				const slug = ((pg.path as string) || '').replace(/^\//, '');
				const existing = items.find((i) => i.slug === slug || i.slug === pg.path);
				const fieldData: IDataObject = {};
				if (pg.meta_title) fieldData['meta-title'] = pg.meta_title;
				if (pg.meta_description) fieldData['meta-description'] = pg.meta_description;
				if (pg.title) fieldData.title = pg.title;
				if (existing) {
					await pgCol.addItems([{ id: existing.id as string, fieldData } as never]);
					updates.push({ path: pg.path, updated: true, id: existing.id });
				} else {
					updates.push({
						path: pg.path,
						error: 'page not found',
						availableSlugs: items.map((i) => i.slug),
					});
				}
			}
		}
		result.updates = updates;
	} else if (operation === 'createPage') {
		const pg = (data.page as IDataObject) || data;
		const pgCol =
			(await findCollection('page')) || (await findCollection('pagina')) || (await findCollection('landing'));
		if (pgCol) {
			await pgCol.addItems([
				{
					slug: pg.slug as string,
					fieldData: {
						title: pg.title,
						'meta-title': pg.meta_title,
						'meta-description': pg.meta_description,
					},
				} as never,
			]);
			result.created = { slug: pg.slug, title: pg.title, addedToCms: true };
		} else {
			result.created = { slug: pg.slug, addedToCms: false, error: 'pages collection not found' };
		}
	} else if (operation === 'createBlogPosts') {
		const posts = (data.posts as IDataObject[]) || [];
		const blogCol = (await findCollection('blog')) || (await findCollection('post'));
		if (blogCol) {
			const created: IDataObject[] = [];
			for (const bp of posts) {
				await blogCol.addItems([
					{
						slug: bp.slug as string,
						fieldData: {
							title: bp.title,
							'meta-description': bp.meta_description,
							body: bp.body,
						},
					} as never,
				]);
				created.push({ slug: bp.slug });
			}
			result.itemsAdded = created.length;
			result.items = created;
		} else {
			result.error = 'Blog collection not found.';
		}
	} else if (operation === 'publish') {
		const pub = await framer.publish();
		result.deployment = pub.deployment as unknown as IDataObject;
		result.note = 'Preview published. Use operation=deploy with deployment.id to promote to production.';
	} else if (operation === 'deploy') {
		const deploymentId = (data.deployment_id || data.deploymentId) as string | undefined;
		if (!deploymentId) {
			result.success = false;
			result.error = 'operation=deploy requires deployment_id (obtained from operation=publish)';
		} else {
			result.deployed = (await framer.deploy(deploymentId)) as unknown as IDataObject;
		}
	} else if (operation === 'publishAndDeploy') {
		const pub = await framer.publish();
		result.deployment = pub.deployment as unknown as IDataObject;
		result.deployed = (await framer.deploy(pub.deployment.id)) as unknown as IDataObject;
		result.note = 'Published and promoted to production in a single call.';
	} else {
		throw new NodeOperationError(ctx.getNode(), `Site Manager: unsupported operation: ${operation}`, {
			itemIndex,
		});
	}

	return result;
}

export class Framer implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Framer',
		name: 'framer',
		icon: 'file:framer.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Read and write Framer CMS, publish previews, deploy to production',
		defaults: { name: 'Framer' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'framerApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Site Manager (Compound)', value: 'siteManager' },
					{ name: 'Project', value: 'project' },
					{ name: 'Collection', value: 'collection' },
					{ name: 'Item', value: 'item' },
					{ name: 'Publish', value: 'publish' },
				],
				default: 'siteManager',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['siteManager'] } },
				options: [
					{ name: 'Read Structure', value: 'readStructure', action: 'Read all collections with fields and item counts' },
					{ name: 'Read Page(s)', value: 'readPages', action: 'Read items by slug path' },
					{ name: 'Read CMS Collection', value: 'readCms', action: 'Read all items of a collection by name' },
					{ name: 'Read CMS Item', value: 'readCmsItem', action: 'Read one item by collection + slug' },
					{ name: 'Audit SEO', value: 'auditSeo', action: 'Scan all items for SEO issues' },
					{ name: 'Read Changes', value: 'readChanges', action: 'List changed paths since last publish' },
					{ name: 'Update SEO / Pages', value: 'updatePages', action: 'Bulk update page fields by path' },
					{ name: 'Create Page', value: 'createPage', action: 'Create a new page in the pages collection' },
					{ name: 'Create Blog Posts', value: 'createBlogPosts', action: 'Create blog posts in the blog collection' },
					{ name: 'Publish', value: 'publish', action: 'Publish a preview' },
					{ name: 'Deploy', value: 'deploy', action: 'Promote deployment to production' },
					{ name: 'Publish and Deploy', value: 'publishAndDeploy', action: 'Publish preview and immediately deploy to production' },
				],
				default: 'readStructure',
			},
			{
				displayName: 'Input JSON',
				name: 'siteManagerInput',
				type: 'json',
				default: '={{ $json }}',
				displayOptions: { show: { resource: ['siteManager'] } },
				description:
					'Payload compatible with the v4 webhook. For most operations leave as $JSON (passes webhook body).',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['project'] } },
				options: [
					{
						name: 'Get Info',
						value: 'getInfo',
						action: 'Get project info',
						description: 'Retrieve display name and hashed ID of the project',
					},
				],
				default: 'getInfo',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['collection'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getMany',
						action: 'List all collections',
						description: 'Returns both managed and unmanaged collections in the project',
					},
					{ name: 'Get', value: 'get', action: 'Get a collection by ID' },
					{ name: 'Get Fields', value: 'getFields', action: 'Get all fields of a collection' },
					{
						name: 'Set Fields',
						value: 'setFields',
						action: 'Replace the field schema of a managed collection',
						description:
							'Only works on collections this integration manages. Pass a JSON array of field definitions.',
					},
				],
				default: 'getMany',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['item'] } },
				options: [
					{ name: 'Get Many', value: 'getMany', action: 'List items in a collection' },
					{
						name: 'Add or Update',
						value: 'addOrUpdate',
						action: 'Add new items or update existing ones',
						description: 'Items with matching IDs are updated, others are inserted. Pass a JSON array of items.',
					},
					{ name: 'Remove', value: 'remove', action: 'Remove items by ID from a collection' },
					{ name: 'Set Order', value: 'setOrder', action: 'Arrange items in a specific order' },
				],
				default: 'getMany',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['publish'] } },
				options: [
					{ name: 'Get Changes', value: 'getChanges', action: 'List paths added removed or modified since last publish' },
					{ name: 'Get Contributors', value: 'getContributors', action: 'List authors who made changes between versions' },
					{
						name: 'Create Preview',
						value: 'createPreview',
						action: 'Publish a new preview link with current changes',
						description: 'Returns the deployment ID needed for Deploy to Production',
					},
					{ name: 'Deploy to Production', value: 'deploy', action: 'Promote a preview deployment to production' },
				],
				default: 'createPreview',
			},
			{
				// Split by resource (rather than one shared show+hide) because 'getMany' means
				// something different per resource: Collection:getMany lists ALL collections (no ID),
				// Item:getMany lists items OF one collection (ID required). A single displayOptions.hide
				// can't express that distinction since hide conditions are OR'd across keys — combining
				// them here previously hid this field for Item:getMany too, whenever operation matched.
				displayName: 'Collection ID',
				name: 'collectionId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['collection'],
						operation: ['get', 'getFields', 'setFields'],
					},
				},
				description: 'The ID of the CMS collection',
			},
			{
				displayName: 'Collection ID',
				name: 'collectionId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getMany', 'addOrUpdate', 'remove', 'setOrder'],
					},
				},
				description: 'The ID of the CMS collection',
			},
			{
				displayName: 'Items (JSON)',
				name: 'itemsJson',
				type: 'json',
				required: true,
				default:
					'[\n  {\n    "id": "optional-existing-id",\n    "slug": "example-slug",\n    "fieldData": {\n      "<field-id>": { "type": "string", "value": "Example" }\n    }\n  }\n]',
				displayOptions: { show: { resource: ['item'], operation: ['addOrUpdate'] } },
				description:
					'Array of items to add or update. Include "id" to update an existing item, omit it to insert a new one. "slug" is a top-level property, not part of fieldData. Each fieldData entry is keyed by field ID (see Collection: Get Fields) and must include a "type" matching that field\'s type, e.g. { "type": "string", "value": "..." } or { "type": "formattedText", "value": "<p>...</p>" }.',
			},
			{
				displayName: 'Item IDs',
				name: 'itemIds',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'id1,id2,id3',
				displayOptions: { show: { resource: ['item'], operation: ['remove', 'setOrder'] } },
				description: 'Comma-separated list of item IDs',
			},
			{
				displayName: 'Fields (JSON)',
				name: 'fieldsJson',
				type: 'json',
				required: true,
				default: '[\n  { "id": "title", "name": "Title", "type": "string" },\n  { "id": "slug", "name": "Slug", "type": "string" }\n]',
				displayOptions: { show: { resource: ['collection'], operation: ['setFields'] } },
				description: 'Array of field definitions. Only valid on collections managed by this integration.',
			},
			{
				displayName: 'Deployment ID',
				name: 'deploymentId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['publish'], operation: ['deploy'] } },
				description: 'The deployment ID returned by Create Preview',
			},
			{
				displayName: 'From Version',
				name: 'fromVersion',
				type: 'number',
				default: 0,
				displayOptions: { show: { resource: ['publish'], operation: ['getContributors'] } },
				description: 'Optional. Starting version number. Leave 0 for default.',
			},
			{
				displayName: 'To Version',
				name: 'toVersion',
				type: 'number',
				default: 0,
				displayOptions: { show: { resource: ['publish'], operation: ['getContributors'] } },
				description: 'Optional. Ending version number. Leave 0 for default.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = (await this.getCredentials('framerApi')) as unknown as FramerApiCredentials;

		const connect = await loadFramerConnect();
		const framer = await connect(credentials.projectUrl, credentials.apiKey);

		try {
			for (let i = 0; i < items.length; i++) {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				try {
					let result: unknown;

					if (resource === 'siteManager') {
						const rawInput = this.getNodeParameter('siteManagerInput', i);
						const input = (typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput || {}) as IDataObject;
						const data = (input.body as IDataObject) || input;
						result = await runSiteManager(framer, operation, data, this, i);
					} else if (resource === 'project' && operation === 'getInfo') {
						result = await framer.getProjectInfo();
					} else if (resource === 'collection' && operation === 'getMany') {
						result = await framer.getCollections();
					} else if (resource === 'collection' && operation === 'get') {
						const id = this.getNodeParameter('collectionId', i) as string;
						const all = await framer.getCollections();
						result = all.find((c) => c.id === id) ?? null;
					} else if (resource === 'collection' && operation === 'getFields') {
						const id = this.getNodeParameter('collectionId', i) as string;
						const collection = await getCollectionById(framer, id, this);
						result = await collection.getFields();
					} else if (resource === 'collection' && operation === 'setFields') {
						const id = this.getNodeParameter('collectionId', i) as string;
						const fields = parseJsonArray(this.getNodeParameter('fieldsJson', i), 'Fields', this);
						const collection = await getCollectionById(framer, id, this);
						if (typeof (collection as unknown as { setFields?: unknown }).setFields !== 'function') {
							throw new NodeOperationError(
								this.getNode(),
								`Collection ${id} is unmanaged. setFields only works on managed collections.`,
								{ itemIndex: i },
							);
						}
						result = await (collection as unknown as { setFields: (f: unknown) => Promise<unknown> }).setFields(
							fields,
						);
					} else if (resource === 'item' && operation === 'getMany') {
						const id = this.getNodeParameter('collectionId', i) as string;
						const collection = await getCollectionById(framer, id, this);
						result = await collection.getItems();
					} else if (resource === 'item' && operation === 'addOrUpdate') {
						const id = this.getNodeParameter('collectionId', i) as string;
						const itemsPayload = parseJsonArray(this.getNodeParameter('itemsJson', i), 'Items', this);
						const collection = await getCollectionById(framer, id, this);
						result = await collection.addItems(itemsPayload as never);
					} else if (resource === 'item' && operation === 'remove') {
						const id = this.getNodeParameter('collectionId', i) as string;
						const ids = parseIdList(this.getNodeParameter('itemIds', i));
						const collection = await getCollectionById(framer, id, this);
						result = await (collection as unknown as { removeItems: (ids: string[]) => Promise<unknown> }).removeItems(
							ids,
						);
					} else if (resource === 'item' && operation === 'setOrder') {
						const id = this.getNodeParameter('collectionId', i) as string;
						const ids = parseIdList(this.getNodeParameter('itemIds', i));
						const collection = await getCollectionById(framer, id, this);
						result = await collection.setItemOrder(ids);
					} else if (resource === 'publish' && operation === 'getChanges') {
						result = await framer.getChangedPaths();
					} else if (resource === 'publish' && operation === 'getContributors') {
						const fromVersion = this.getNodeParameter('fromVersion', i) as number;
						const toVersion = this.getNodeParameter('toVersion', i) as number;
						result = await (
							framer as unknown as {
								getChangeContributors: (from?: number, to?: number) => Promise<unknown>;
							}
						).getChangeContributors(fromVersion || undefined, toVersion || undefined);
					} else if (resource === 'publish' && operation === 'createPreview') {
						result = await framer.publish();
					} else if (resource === 'publish' && operation === 'deploy') {
						const deploymentId = this.getNodeParameter('deploymentId', i) as string;
						result = await framer.deploy(deploymentId);
					} else {
						throw new NodeOperationError(
							this.getNode(),
							`Unsupported combination: resource=${resource}, operation=${operation}`,
							{ itemIndex: i },
						);
					}

					returnData.push({
						json: { resource, operation, data: (result ?? null) as IDataObject },
						pairedItem: { item: i },
					});
				} catch (error) {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: getErrorMessage(error), resource, operation },
							pairedItem: { item: i },
						});
						continue;
					}
					throw error;
				}
			}
		} finally {
			await framer.disconnect();
		}

		return [returnData];
	}
}
