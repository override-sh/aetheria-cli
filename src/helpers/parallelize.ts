/**
 * Parallelize promises and await them all
 * @param {Promise<any>} promises The promises to parallelize
 * @returns {Promise<any[]>} The results of the promises
 */
export const parallelize = <T extends Array<Promise<any>>>(...promises: T) => Promise.all(promises);
