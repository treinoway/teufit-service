import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAddressByPostalCode } from '../../src/services/address-service.js';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('address-service', () => {
	beforeEach(() => {
		mockFetch.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('getAddressByPostalCode', () => {
		it('successfully fetches address for valid postal code', async () => {
			const mockViaCepResponse = {
				cep: '01310-100',
				logradouro: 'Avenida Paulista',
				complemento: '',
				bairro: 'Bela Vista',
				localidade: 'São Paulo',
				uf: 'SP',
				estado: 'São Paulo',
				erro: false,
			};

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockViaCepResponse,
			});

			const result = await getAddressByPostalCode('01310-100');

			expect(mockFetch).toHaveBeenCalledWith('https://viacep.com.br/ws/01310100/json/');
			expect(result).toEqual({
				line1: 'Avenida Paulista',
				line2: null, // Empty strings are converted to null
				neighborhood: 'Bela Vista',
				city: 'São Paulo',
				state: 'São Paulo',
				stateCode: 'SP',
				country: 'Brasil',
				countryCode: 'BR',
				postalCode: '01310-100',
			});
		});

		it('successfully fetches address for postal code without formatting', async () => {
			const mockViaCepResponse = {
				cep: '01310-100',
				logradouro: 'Avenida Paulista',
				complemento: 'lado ímpar',
				bairro: 'Bela Vista',
				localidade: 'São Paulo',
				uf: 'SP',
				estado: 'São Paulo',
			};

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockViaCepResponse,
			});

			const result = await getAddressByPostalCode('01310100');

			expect(mockFetch).toHaveBeenCalledWith('https://viacep.com.br/ws/01310100/json/');
			expect(result).toEqual({
				line1: 'Avenida Paulista',
				line2: 'lado ímpar',
				neighborhood: 'Bela Vista',
				city: 'São Paulo',
				state: 'São Paulo',
				stateCode: 'SP',
				country: 'Brasil',
				countryCode: 'BR',
				postalCode: '01310-100',
			});
		});

		it('handles null/empty fields from ViaCEP response', async () => {
			const mockViaCepResponse = {
				cep: '12345-678',
				logradouro: '',
				complemento: '',
				bairro: '',
				localidade: 'Some City',
				uf: 'SC',
				estado: 'Some State',
			};

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockViaCepResponse,
			});

			const result = await getAddressByPostalCode('12345678');

			expect(result).toEqual({
				line1: null,
				line2: null,
				neighborhood: null,
				city: 'Some City',
				state: 'Some State',
				stateCode: 'SC',
				country: 'Brasil',
				countryCode: 'BR',
				postalCode: '12345-678',
			});
		});

		it('throws error when postal code is not provided', async () => {
			await expect(getAddressByPostalCode('')).rejects.toMatchObject({
				message: 'Postal code is required',
				code: 'POSTAL_CODE_REQUIRED',
				statusCode: 400,
			});

			await expect(getAddressByPostalCode(null)).rejects.toMatchObject({
				message: 'Postal code is required',
				code: 'POSTAL_CODE_REQUIRED',
				statusCode: 400,
			});

			await expect(getAddressByPostalCode(undefined)).rejects.toMatchObject({
				message: 'Postal code is required',
				code: 'POSTAL_CODE_REQUIRED',
				statusCode: 400,
			});
		});

		it('throws error when postal code format is invalid (too short)', async () => {
			await expect(getAddressByPostalCode('123')).rejects.toMatchObject({
				message: 'Invalid postal code format. Brazilian postal codes must have 8 digits',
				code: 'INVALID_POSTAL_CODE_FORMAT',
				statusCode: 400,
			});
		});

		it('throws error when postal code format is invalid (too long)', async () => {
			await expect(getAddressByPostalCode('123456789')).rejects.toMatchObject({
				message: 'Invalid postal code format. Brazilian postal codes must have 8 digits',
				code: 'INVALID_POSTAL_CODE_FORMAT',
				statusCode: 400,
			});
		});

		it('throws error when postal code is not found', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ erro: true }),
			});

			await expect(getAddressByPostalCode('99999999')).rejects.toMatchObject({
				message: 'Postal code not found',
				code: 'POSTAL_CODE_NOT_FOUND',
				statusCode: 404,
			});

			expect(mockFetch).toHaveBeenCalledWith('https://viacep.com.br/ws/99999999/json/');
		});

		it('throws error when ViaCEP API returns non-ok status', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			await expect(getAddressByPostalCode('01310100')).rejects.toMatchObject({
				message: 'Failed to fetch postal code information',
				code: 'POSTAL_CODE_API_ERROR',
				statusCode: 502,
			});
		});

		it('throws error when fetch fails with network error', async () => {
			mockFetch.mockRejectedValueOnce(new Error('Network error'));

			await expect(getAddressByPostalCode('01310100')).rejects.toMatchObject({
				message: 'Failed to fetch postal code information',
				code: 'POSTAL_CODE_API_ERROR',
				statusCode: 502,
			});
		});

		it('throws error when JSON parsing fails', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => {
					throw new Error('Invalid JSON');
				},
			});

			await expect(getAddressByPostalCode('01310100')).rejects.toMatchObject({
				message: 'Failed to fetch postal code information',
				code: 'POSTAL_CODE_API_ERROR',
				statusCode: 502,
			});
		});

		it('strips special characters from postal code before calling API', async () => {
			const mockViaCepResponse = {
				cep: '01310-100',
				logradouro: 'Avenida Paulista',
				complemento: '',
				bairro: 'Bela Vista',
				localidade: 'São Paulo',
				uf: 'SP',
				estado: 'São Paulo',
			};

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockViaCepResponse,
			});

			await getAddressByPostalCode('01.310-100');

			expect(mockFetch).toHaveBeenCalledWith('https://viacep.com.br/ws/01310100/json/');
		});
	});
});
