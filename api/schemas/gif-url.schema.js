import { GIF_URL_PATTERN, GIF_URL_MAX_LENGTH } from '../../src/constants/exercise-media.js';

export const gifUrlRequestSchema = {
  type: ['string', 'null'],
  pattern: GIF_URL_PATTERN,
  maxLength: GIF_URL_MAX_LENGTH,
};

export const gifUrlResponseSchema = { type: ['string', 'null'] };
