import { getAddressByPostalCode } from '../../src/services/address-service.js';
import { getPostalCodeSchema } from '../schemas/address-route.schema.js';

export async function addressRoutes(fastify) {
	fastify.get(
		'/postal-code',
		{
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
