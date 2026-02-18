import { getAddressByPostalCode } from '../../src/services/address-service.js';
import { getPostalCodeSchema } from '../schemas/address-route.schema.js';
import config from '../../config/index.js';

export async function addressRoutes(fastify) {
	// Rate limit configured in config/environments/*.js
	// Default: 10 req/min (disabled in test environment)
	fastify.get(
		'/postal-code',
		{
			config: {
				rateLimit: config.rateLimit.postalCode,
			},
			schema: getPostalCodeSchema,
		},
		async (request, reply) => {
			try {
				const { code } = request.query;
				const addressInfo = await getAddressByPostalCode(code);
				return reply.send(addressInfo);
			} catch (error) {
				request.log.error({ error }, 'Error fetching postal code in GET /postal-code');

				const statusCode = error.statusCode || 500;
				const errorCode = error.code || 'INTERNAL_SERVER_ERROR';
				const message = error.message || 'Internal server error';

				return reply.status(statusCode).send({
					error: errorCode,
					message,
				});
			}
		}
	);
}
