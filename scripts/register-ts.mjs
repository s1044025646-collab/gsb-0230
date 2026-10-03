import { register } from "node:module";
await register(new URL("./ts-loader.mjs", import.meta.url));
