import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.ENV_DB_URL, max: 5 });
