import { PostalCodeErrorCode } from '../constants/address.js';

/**
 * Address service
 * Provides integration with postal code APIs (e.g., ViaCEP for Brazilian addresses)
 */

/**
 * Fetches address information from a Brazilian postal code (CEP)
 * @param {string} postalCode - The postal code to lookup (e.g., "01310-100" or "01310100")
 * @returns {Promise<Object>} Address information
 * @throws {Error} If postal code is invalid or not found
 */
export async function getAddressByPostalCode(postalCode) {
	if (!postalCode) {
		const err = new Error('Postal code is required');
		err.code = PostalCodeErrorCode.REQUIRED;
		err.statusCode = 400;
		throw err;
	}

	// Remove non-numeric characters
	const cleanPostalCode = postalCode.replace(/\D/g, '');

	// Validate Brazilian postal code format (8 digits)
	if (cleanPostalCode.length !== 8) {
		const err = new Error('Invalid postal code format. Brazilian postal codes must have 8 digits');
		err.code = PostalCodeErrorCode.INVALID_FORMAT;
		err.statusCode = 400;
		throw err;
	}

	try {
		const response = await fetch(`https://viacep.com.br/ws/${cleanPostalCode}/json/`);

		if (!response.ok) {
			const err = new Error('Failed to fetch postal code information');
			err.code = PostalCodeErrorCode.API_ERROR;
			err.statusCode = 502;
			throw err;
		}

		const data = await response.json();

		// ViaCEP returns { erro: true } when postal code is not found
		if (data.erro) {
			const err = new Error('Postal code not found');
			err.code = PostalCodeErrorCode.NOT_FOUND;
			err.statusCode = 404;
			throw err;
		}

		// Transform ViaCEP response to match our address schema
		return {
			line1: data.logradouro || null,
			line2: data.complemento || null,
			neighborhood: data.bairro || null,
			city: data.localidade || null,
			state: data.estado || null,
			stateCode: data.uf || null,
			country: 'Brasil',
			countryCode: 'BR',
			postalCode: data.cep || null,
		};
	} catch (error) {
		// Re-throw our custom errors
		if (error.code && error.statusCode) {
			throw error;
		}

		// Handle network or parsing errors
		const err = new Error('Failed to fetch postal code information');
		err.code = PostalCodeErrorCode.API_ERROR;
		err.statusCode = 502;
		err.cause = error;
		throw err;
	}
}
