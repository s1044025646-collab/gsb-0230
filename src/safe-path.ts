import { resolve, sep, relative, normalize } from "node:path";
import { AppError } from "./errors.js";

/**
 * 把种子内的相对路径片段安全解析到样例根目录下。
 * 拒绝绝对路径、盘符、`..` 越界以及保留设备名（Windows）。
 */
export function safeJoin(root: string, parts: string[]): string {
  if (parts.length === 0) {
    throw new AppError("METADATA_CORRUPT", "文件路径为空");
  }
  for (const part of parts) {
    if (typeof part !== "string" || part.length === 0) {
      throw new AppError("METADATA_CORRUPT", "文件路径包含空片段");
    }
    if (part.includes("\0")) {
      throw new AppError("BAD_REQUEST", "路径包含空字节");
    }
  }
  const rel = parts.map((p) => p.replace(/[\\/]/g, "/")).join("/");
  const normalized = normalize(rel);
  if (normalized === ".." || normalized.startsWith(".." + sep) || pathIsAbsolute(normalized)) {
    throw new AppError("PATH_TRAVERSAL", `路径越出样例根目录：${rel}`);
  }
  const abs = resolve(root, normalized);
  const relFromRoot = relative(root, abs);
  if (relFromRoot === ".." || relFromRoot.startsWith(".." + sep) || resolve(abs) === resolve(root)) {
    throw new AppError("PATH_TRAVERSAL", `路径越出样例根目录：${rel}`);
  }
  if (hasWindowsDeviceName(relFromRoot)) {
    throw new AppError("PATH_TRAVERSAL", `路径命中 Windows 保留设备名：${rel}`);
  }
  return abs;
}

function pathIsAbsolute(p: string): boolean {
  if (p.startsWith("/") || p.startsWith("\\")) return true;
  return /^[a-zA-Z]:[\\/]/.test(p);
}

function hasWindowsDeviceName(relPath: string): boolean {
  const reserved = new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  ]);
  return relPath
    .split(/[\\/]/)
    .some((seg) => {
      const stem = seg.split(".")[0]!.toUpperCase();
      return reserved.has(stem);
    });
}

/** 校验调用方给出的相对目录（校验根）也在样例根内。 */
export function safeRootedDir(root: string, relDir: string): string {
  const normalized = normalize(relDir).replace(/^[\\/]+/, "");
  const abs = resolve(root, normalized);
  const r = relative(root, abs);
  if (r === ".." || r.startsWith(".." + sep)) {
    throw new AppError("PATH_TRAVERSAL", `校验目录越出样例根目录：${relDir}`);
  }
  return abs;
}
