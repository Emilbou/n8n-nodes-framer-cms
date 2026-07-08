import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class FramerApi implements ICredentialType {
	name = 'framerApi';

	displayName = 'Framer API';

	documentationUrl = 'https://www.framer.com/developers/server-api-introduction';

	icon = 'file:framer.svg' as const;

	properties: INodeProperties[] = [
		{
			displayName: 'Project URL',
			name: 'projectUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://framer.com/projects/Sites--aabbccddeeff',
			description:
				'The full URL of your Framer project. Find it in the browser address bar when the project is open.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Generate an API key in the Framer site settings of your project. The key is shown only once at creation.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.projectUrl}}',
			url: '/',
			method: 'HEAD',
		},
	};
}
