/** Validates Express `/hls/:jobId/*` ids and disk job folders */
export const UUID_REGEX = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
