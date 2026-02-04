export const getPostalCodeSchema = {
	tags: ['address'],
	summary: 'Get address information by postal code',
	description: 'Fetches address details for a given Brazilian postal code (CEP) from ViaCEP API',
	security: [{ bearerAuth: [] }],
	querystring: {
		type: 'object',
		required: ['code'],
		properties: {
			code: {
				type: 'string',
				description: 'Brazilian postal code (CEP) with or without formatting (e.g., "01310-100" or "01310100")',
				minLength: 8,
				maxLength: 10,
			},
		},
	},
	response: {
		200: {
			description: 'Address information for the postal code',
			type: 'object',
			properties: {
				line1: { type: 'string', nullable: true, description: 'Primary street address line' },
				line2: { type: 'string', nullable: true, description: 'Secondary address line (apt, suite, etc.)' },
				neighborhood: { type: 'string', nullable: true, description: 'Neighborhood or district' },
				city: { type: 'string', nullable: true, description: 'City name' },
				state: { type: 'string', nullable: true, description: 'State or province name' },
				stateCode: { type: 'string', nullable: true, description: 'State or province code (e.g., "SP")' },
				country: { type: 'string', nullable: true, description: 'Country name' },
				countryCode: { type: 'string', nullable: true, description: 'ISO country code (e.g., "BR")' },
				postalCode: { type: 'string', nullable: true, description: 'Postal or ZIP code' },
			},
			additionalProperties: false,
		},
		400: {
			description: 'Bad request - Invalid postal code format',
			type: 'object',
			properties: {
				error: { type: 'string' },
				message: { type: 'string' },
			},
		},
		401: {
			description: 'Unauthorized - Authentication required',
			type: 'object',
			properties: {
				error: { type: 'string' },
			},
		},
		404: {
			description: 'Postal code not found',
			type: 'object',
			properties: {
				error: { type: 'string' },
				message: { type: 'string' },
			},
		},
		502: {
			description: 'External API error',
			type: 'object',
			properties: {
				error: { type: 'string' },
				message: { type: 'string' },
			},
		},
	},
};
