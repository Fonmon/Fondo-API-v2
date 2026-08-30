/**
 * The `.env` files loaded in development, in precedence order.
 * Deployed environments inject real variables and ship no `.env` at all.
 */
export const ENV_FILE_PATHS = ['.env.local', '.env'] as const;
