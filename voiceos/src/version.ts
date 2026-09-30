// Set at release build time (scripts/build-release.ts); a build from source is 'dev'.
declare const VOICEOS_VERSION: string | undefined;

export const VERSION: string = typeof VOICEOS_VERSION === 'string' ? VOICEOS_VERSION : 'dev';
