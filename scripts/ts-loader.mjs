/**
 * 让 Node 直接执行 TypeScript 源码：把相对导入的 `.js` 重写到同路径 `.ts`。
 * 仅用于测试与脚本运行；正式运行使用 tsc 构建后的 dist/*.js。
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    const tsSpec = specifier.slice(0, -3) + ".ts";
    try {
      const resolved = new URL(tsSpec, context.parentURL);
      if (existsSync(fileURLToPath(resolved))) {
        return await nextResolve(pathToFileURL(fileURLToPath(resolved)).href, context);
      }
    } catch {
      // fall through
    }
  }
  return await nextResolve(specifier, context);
}
