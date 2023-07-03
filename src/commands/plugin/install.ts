import { tryResolutionPaths } from "@aetheria/config";
import { Flags } from "@oclif/core";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as typescript from "typescript";
import { BaseCommand } from "../../base";
import { NextConventionalFilenames } from "../../constants/frontend";
import { loadPlugin, parallelize } from "../../helpers";
import { ConfigurationJSON, PluginData } from "../../interfaces";

export class PluginInstall extends BaseCommand<typeof PluginInstall> {
	static summary = "Install a plugin";

	static examples = [ "<%= config.bin %> <%= command.id %> -c ./apps/frontend/aetheria.json -a ./apps/frontend/app" ];

	static flags = {
		...BaseCommand.flags,
		configuration:   Flags.file({
			char:        "c",
			description: "The path to the plugins configuration file",
		}),
		resolution_path: Flags.string({
			char:        "r",
			description: "The path to the plugins resolution directory",
		}),
		name:            Flags.string({
			char:        "n",
			description: "The name of the plugin to install",
		}),
		app_path:        Flags.string({
			char:        "a",
			description: "The path to the project source directory",
		}),
		project:         Flags.string({
			char:        "p",
			description: "The path to the project root directory",
			options:     [
				"frontend",
				"backend",
			],
		}),
	};

	public async run(): Promise<void> {
		await this.requireMissingParameters();
		const configuration = await this.loadConfiguration();

		await this.runLocalInstallation(configuration);
	}

	/**
	 * Load the configuration file
	 * @returns {Promise<ConfigurationJSON>} The configuration file
	 */
	async loadConfiguration() {
		return JSON.parse(await readFile(this.flags.configuration as string, "utf-8")) as ConfigurationJSON;
	}

	/**
	 * Save the configuration file
	 * @param {ConfigurationJSON} configuration The configuration content
	 * @returns {Promise<void>} The configuration file
	 */
	async saveConfiguration(configuration: ConfigurationJSON) {
		await writeFile(this.flags.configuration as string, JSON.stringify(configuration, null, 4));
	}

	/**
	 * Install a local plugin
	 * @param {ConfigurationJSON} configuration The configuration file
	 * @returns {Promise<void>} The promise
	 */
	async runLocalInstallation(configuration: ConfigurationJSON) {
		const plugin = loadPlugin(
			await tryResolutionPaths({
				id:      this.flags.name as string,
				resolve: this.flags.resolution_path as string,
			}, {
				filename:        "package.json",
				resolution_path: this.flags.app_path as string,
				enable_parent:   true,
			}),
		);

		if (configuration.plugins.find((value) => plugin.name === value.id)) {
			this.error(`Plugin ${plugin.name} is already installed, please uninstall it first`);
		}

		await this.install(plugin, configuration);

		if (this.flags.project === "frontend") {
			await this.importNextRoutes();
			await this.importReactComponents();
		}
	}

	/**
	 * Import the React components from the plugin
	 * @returns {Promise<void>} The promise
	 */
	async importReactComponents() {
		this.log("Importing react components");

		const resolution_path = resolve(
			this.flags.configuration as string,
			this.flags.resolution_path as string,
			"src/index.ts",
		);
		try {
			const index_content = await readFile(resolution_path, "utf-8");

			if (index_content.length === 0) {
				this.warn("Cannot find default react components export file. No react components will be imported.");
				return;
			}

			const plugins_source_file_path = resolve(this.flags.app_path as string, "plugins.ts");
			const plugins_source_file_content = await readFile(plugins_source_file_path, "utf-8");

			const plugins_source_file = typescript.createSourceFile(
				plugins_source_file_path,
				plugins_source_file_content,
				typescript.ScriptTarget.Latest,
				true,
			);

			const new_import = `\timport("${this.flags.name}"),`;
			let have_found_injection_point = false;
			let have_confirmed_injection_point = false;
			let last_import_end = 0;

			// Visit the AST to find the injection point and the last import
			const visit = (node: typescript.Node) => {
				// If an identifier is found and it's the injectable identifier, we've -- probably -- found the
				// injection point, it need to be confirmed by finding an array literal expression containing at least
				// an import
				if (typescript.isIdentifier(node) && node.text === "injectable") {
					this.logDebug("Found plugins injection point");
					have_found_injection_point = true;
				}
					// If an array literal expression is found and we've found the injection point, we need to confirm
				// it by finding an import, if we do, we can confirm the injection point
				else if (typescript.isArrayLiteralExpression(node)) {
					if (have_found_injection_point && node.getText().includes("import(")) {
						this.logDebug("Injection point confirmed, found import array");
						have_confirmed_injection_point = true;
					}
				}
				// If we've found the injection point and we've confirmed it, we're now looking for the last import
				else if (have_confirmed_injection_point && typescript.isCallExpression(node)) {
					last_import_end = node.getEnd() + 1;
					this.logDebug(`Found call expression ending at ${last_import_end}`);
				}

				node.forEachChild(visit);
			};

			// Visit the AST to find the injection point
			plugins_source_file.forEachChild(visit);

			// If we've found the injection point and we've confirmed it, we can insert the new import
			if (have_confirmed_injection_point && last_import_end > 0) {
				this.logDebug(`Confirmed last import at ${last_import_end}, inserting new import`);

				// Insert the new import at the end of the last import
				const new_plugins_source_file_content =
					plugins_source_file_content.slice(0, last_import_end) +
					"\n" +
					new_import +
					plugins_source_file_content.slice(last_import_end);

				await writeFile(plugins_source_file_path, new_plugins_source_file_content);
				this.log("React components imported");
			}
			else {
				this.warn("Cannot find injection point for react components. No react component have been imported.");
			}
		}
		catch (error: any) {
			this.logDebug(error.message);
			this.warn("Cannot find default react components export file. No react components will be imported.");
		}
	}

	/**
	 * Import the Next.js routes from the plugin creating the necessary symlinks
	 * @returns {Promise<void>} The promise
	 */
	async importNextRoutes() {
		this.log("Importing next routes");

		const resolution_path = resolve(
			this.flags.configuration as string,
			this.flags.resolution_path as string,
			"src/routes",
		);
		const routes = await readdir(resolution_path, {
			encoding:      "utf-8",
			recursive:     true,
			withFileTypes: true,
		});

		// Filter the routes to import only the files that are in the resolution path and have a conventional name
		// will be imported as the other may only be used by the plugin itself
		const routesToImport = routes.filter(
			(value) => value.isFile() && NextConventionalFilenames.some((filename) => filename.test(value.name)),
		);

		await parallelize(
			...routesToImport.map(async (route) => {
				// The folder is the path without the resolution path
				const folder = route.path.replaceAll(`${resolution_path}/`, "");

				try {
					const file_destination = resolve(this.flags.app_path as string, folder, route.name);

					// Creates the folder if it doesn't exist
					await mkdir(resolve(this.flags.app_path as string, folder), {
						recursive: true,
					});

					// Create the symlink to the route
					await symlink(resolve(route.path, route.name), file_destination);

					this.log(`Route '${folder}/${route.name}' imported!`);
				}
				catch (error: any) {
					this.warn(`Route '${folder}/${route.name}' already exists! Skipped.`);
					this.logDebug(error.message);
				}
			}),
		);
	}

	/**
	 * Install a plugin
	 * @param {PluginData} plugin The plugin to install
	 * @param {ConfigurationJSON} configuration The configuration file
	 * @returns {Promise<void>} The promise
	 */
	async install(plugin: PluginData, configuration: ConfigurationJSON) {
		this.log(`Installing plugin ${plugin.name} (v${plugin.version})`);

		configuration.plugins.push({
			id:      this.flags.name as string,
			resolve: this.flags.resolution_path as string,
		});
		await this.saveConfiguration(configuration);

		this.log(`Plugin ${plugin.name} (v${plugin.version}) installed`);
	}

	/**
	 * Require the missing command line parameters
	 * @returns {Promise<void>} The promise
	 * @private
	 */
	private async requireMissingParameters() {
		const inquirer = require("inquirer");

		if (!this.flags.project) {
			this.flags.project = (await inquirer.prompt([
				{
					type:    "list",
					name:    "project",
					message: "Which project do you want to install the plugin for?",
					choices: [
						"frontend",
						"backend",
					],
				},
			])).project;
		}

		if (!this.flags.configuration) {
			this.flags.configuration = (await inquirer.prompt([
				{
					type:     "input",
					name:     "configuration",
					message:  "Where is the plugin config file located?",
					validate: (value: string) => {
						return existsSync(value) ? true : "The file doesn't exist";
					},
				},
			])).configuration;
		}

		if (!this.flags.resolution_path) {
			this.flags.resolution_path = (await inquirer.prompt([
				{
					type:     "input",
					name:     "resolution_path",
					message:  "Where is the plugin located?",
					validate: (value: string) => {
						return existsSync(value) ? true : "The folder doesn't exist";
					},
				},
			])).resolution_path;
		}

		if (!this.flags.name) {
			this.flags.name = (await inquirer.prompt([
				{
					type:     "input",
					name:     "name",
					message:  "Which is the plugin's name?",
					validate: (value: string) => {
						return value.length > 0 ? true : "The name cannot be empty";
					},
				},
			])).name;
		}

		if (!this.flags.app_path) {
			this.flags.app_path = (await inquirer.prompt([
				{
					type:     "input",
					name:     "app_path",
					message:  "Where is the project located?",
					validate: (value: string) => {
						return existsSync(value) ? true : "The folder doesn't exist";
					},
				},
			])).app_path;
		}
	}
}
