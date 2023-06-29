import { PluginData } from "../interfaces";

/**
 * Load a plugin from a string
 * @param {string} content The content of the plugin
 * @returns {PluginData} The plugin
 */
export function loadPlugin(content: string): PluginData {
	return JSON.parse(content) as PluginData;
}
