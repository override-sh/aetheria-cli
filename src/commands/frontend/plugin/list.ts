import { getConfiguration, resolvePlugins } from "@aetheria/config";
import { Flags } from "@oclif/core";
import * as Table from "cli-table3";
import { BaseCommand } from "../../../base";


export class PluginList extends BaseCommand<typeof PluginList> {
	static summary = "List the installed plugins";

	static examples = [ "<%= config.bin %> <%= command.id %> -c ./apps/frontend/aetheria.json" ];

	static flags = {
		...BaseCommand.flags,
		configuration: Flags.file({
			char:        "c",
			description: "The path to the plugins configuration file",
			required:    true,
		}),
	};

	public async run(): Promise<void> {
		const plugins = await this.loadPlugins();

		const table = new Table({
			head:  [
				"Plugin",
				"Version",
			],
			style: {
				head: [
					"bold",
					"green",
				],
			},
		});
		table.push(...plugins);

		console.log(table.toString());
	}

	/**
	 * Load the plugins from the configuration file
	 * @returns {Promise<[string, string][]>} The plugins
	 */
	async loadPlugins() {
		const configuration = await getConfiguration(this.flags.configuration);
		const plugins = await resolvePlugins(configuration, this.flags.configuration);

		return plugins.map((plugin): [ string, string ] => [
			plugin.name,
			plugin.version,
		]);
	}
}
