import path from 'node:path';

export function resolvesThroughHiddenPath(root, resolvedPath) {
    const relativePath = path.relative(root, resolvedPath);
    return relativePath.split(path.sep).some(segment => segment.startsWith('.'));
}
