// Loads the keys from .env.local when it exists (on your computer). In GitHub
// Actions they come from the repo's secrets instead.
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
