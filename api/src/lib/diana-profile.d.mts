export type DianaFiles = { harness: string; voice: string; charter: string; hardRules: string; learning: string; memory: string };
export function toks(s: unknown): Set<string>;
export function parseEntries(text: unknown): { heading: string; text: string }[];
export function matchEntries<T extends { heading: string }>(query: string, entries: T[], top?: number): T[];
export function composeDiana(files: DianaFiles, query: string): string;
