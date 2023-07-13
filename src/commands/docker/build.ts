import { Args, Flags } from "@oclif/core";
import { spawn } from "node:child_process";
import { Dirent } from "node:fs";
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BaseCommand } from "../../base";
import { parallelize } from "../../helpers";
import semver = require("semver/preload");

export class Build extends BaseCommand<typeof Build> {
	static summary = "Build a docker image for the backend";

	static examples = [
		{
			command:     "<%= config.bin %> <%= command.id %> frontend base -f ../frontend/",
			description: "Build the base image for the frontend located in ../frontend/",
		},
		{
			command:     "<%= config.bin %> <%= command.id %> backend base -v 1.0.1 -f ../headless/",
			description: "Build the base image with version 1.0.1 where the headless backend is located at ../headless/",
		},
	];

	static available_presets = [ "base" ];

	static flags = {
		...BaseCommand.flags,
		project_folder: Flags.string({
			char:        "f",
			description: "The folder where the project is located",
		}),
		build:          Flags.boolean({
			description: "Whether to build the source code before building the image",
			default:     true,
			allowNo:     true,
		}),
		version:        Flags.string({
			char:        "v",
			description: "The version of the image to build",
			default:     "1.0.0",
		}),
		publish:        Flags.boolean({
			description: "Whether to publish the image",
			default:     true,
			allowNo:     true,
		}),
	};

	static args = {
		project: Args.string({
			description: "The project to build",
			options:     [
				"frontend",
				"backend",
			],
		}),
		image:   Args.string({
			description: "The image to build",
			options:     Build.available_presets,
		}),
	};

	protected docker_folder!: string;

	public async run() {
		await this.getMissingParameters();

		await this.verifyDockerFolderPresence();

		if (this.flags.build) {
			await this.cleanupDistFolder();
			await this.buildProject();
		}

		await this.copyDistributionFiles();
		await this.copySupportFiles();

		// extra step for backend building
		if (this.args.project === "backend") {
			await this.cloneRootNestDependencies();
		}

		await this.buildImage();
		await this.publish();
	}

	/**
	 * Clone the root @nestjs dependencies into the docker folder of the backend
	 * @returns {Promise<void>} A promise that resolves when the dependencies are cloned
	 */
	private async cloneRootNestDependencies() {
		this.log("Cloning root @nestjs dependencies ...");

		const resolution_path = resolve(this.flags.headless_folder as string, "package.json");
		const pjson = JSON.parse(await readFile(resolution_path, { encoding: "utf-8" }));

		const dependencies = Object.keys(pjson.dependencies)
		                           .filter((dep) => dep.startsWith("@nestjs"))
		                           .reduce((acc, dep) => {
			                           acc[dep] = pjson.dependencies[dep];

			                           return acc;
		                           }, {} as Record<string, string>);

		const image_pjson_path = resolve(
			this.docker_folder,
			"package.json",
		);
		const image_pjson = JSON.parse(await readFile(image_pjson_path, { encoding: "utf-8" }));
		image_pjson.dependencies = { ...image_pjson.dependencies, ...dependencies };

		await writeFile(image_pjson_path, JSON.stringify(image_pjson, null, 4));

		this.log("Root @nestjs dependencies cloned successfully");
	}

	/**
	 * Publish the image to docker hub, only publishes the backend image
	 * @returns {Promise<void>} A promise that resolves when the image is published
	 * @private
	 */
	private publish() {
		if (this.args.project === "frontend" && this.flags.publish) {
			this.warn("Publishing disabled for frontend images");
			return Promise.resolve();
		}

		if (!this.flags.publish) {
			this.warn("Skipping publish");
			return Promise.resolve();
		}

		// from here on, we're publishing the backend image (aka the headless backend)
		return new Promise<void>((ok, fail) => {
			const image_tag = `${this.flags.version}-${this.args.image}`;
			const image_latest_tag = `latest-${this.args.image}`;
			const image_name = `overridesoft/aetheria-headless:`;

			const images_to_publish = [
				`${image_name}${image_tag}`,
				`${image_name}${image_latest_tag}`,
			];

			this.log(`Publishing images: ${images_to_publish.join(", ")} - this may take some time ...`);

			const child = spawn(
				images_to_publish.map((image) => `docker push ${image}`).join(" && "),
				{
					cwd:   this.docker_folder,
					shell: true,
				},
			);

			child.stdout.on("data", (data) => {
				console.log(data.toString());
			});

			child.stderr.on("data", (data) => {
				console.log(data.toString());
			});

			child.on("error", (err) => {
				this.safeError(err);
			});

			child.on("close", (code) => {
				if (code === 0) {
					this.log(`Images published successfully`);
					ok();
				}
				else {
					this.error(`Build failed with code ${code}`);
					fail();
				}
			});
		});
	}

	/**
	 * Remove the dist folder from the project
	 * @returns {Promise<void>} A promise that resolves when the dist folder is removed
	 * @private
	 */
	private async cleanupDistFolder() {
		this.log("Cleaning up dist folder ...");

		await rm(resolve(this.flags.project_folder as string, "dist"), {
			recursive: true,
			force:     true,
		});
	}

	/**
	 * Build the docker image
	 * @returns {Promise<void>} A promise that resolves when the image is built
	 * @private
	 */
	private buildImage() {
		return new Promise<void>((ok, fail) => {
			const image_tag = `${this.flags.version}-${this.args.image}`;
			const image_latest_tag = `latest-${this.args.image}`;
			const image_name = this.args.project === "frontend"
				? `overridesoft/aetheria-frontend:`
				: `overridesoft/aetheria-headless:`;

			this.log(`Building image '${image_name}${image_tag}', this may take some time ...`);

			const child = spawn(
				`docker build -t ${image_name}${image_tag} . && docker tag ${image_name}${image_tag} ${image_name}${image_latest_tag}`,
				{
					cwd:   this.docker_folder,
					shell: true,
				},
			);

			child.on("error", (err) => {
				this.safeError(err);
			});

			child.on("close", (code) => {
				if (code === 0) {
					this.log(`Image '${image_name}${image_tag}' and '${image_name}${image_latest_tag}' built successfully`);
					ok();
				}
				else {
					this.error(`Build failed with code ${code}`);
					fail();
				}
			});
		});
	}

	/**
	 * Copy the support files to the docker dist folder
	 * @returns {Promise<void>} A promise that resolves when the files are copied
	 * @private
	 */
	private async copySupportFiles() {
		this.log("Copying support files ...");

		const files: string[] = this.args.project === "frontend"
			? []
			: [
				resolve(this.flags.project_folder as string, "tailwind.css"),
				resolve(this.flags.project_folder as string, "tailwind.config.js"),
				resolve(this.flags.project_folder as string, "postcss.config.js"),
			];

		await parallelize(...files.map(async (file) => {
			this.logDebug(`Copying ${file} to ${this.args.image}/${basename(file)}`);

			return cp(
				file,
				resolve(
					this.docker_folder,
					"dist",
					basename(file),
				),
			);
		}));

		this.log("Distribution files copied successfully");
	}

	/**
	 * Copy the distribution files of the frontend project to the docker dist folder
	 * @returns {Promise<void>} A promise that resolves when the files are copied
	 * @private
	 */
	private async copyDistributionFilesFE() {
		const resolution_path = resolve(this.flags.project_folder as string, "dist/apps/frontend");

		const files = await readdir(
			resolution_path,
			{
				withFileTypes: true,
				encoding:      "utf-8",
			},
		);

		await this.runFilesCopy(files, resolution_path);
	}

	/**
	 * Run the real copy of the distribution files, regardless of the project type
	 * @param {Dirent[]} files The files to copy
	 * @param {string} resolution_path The path to resolve the files from
	 * @returns {Promise<Awaited<any>[]>} A promise that resolves when the files are copied
	 * @private
	 */
	private runFilesCopy(files: Dirent[], resolution_path: string) {
		return parallelize(...files.map(async (file) => {
			const clean_path = file.path.replace(resolution_path, "");

			this.logDebug(`Copying ${clean_path}${file.name} to ${this.args.image}/${clean_path}${file.name}`);

			return cp(
				resolve(file.path, file.name),
				resolve(
					this.docker_folder,
					"dist",
					clean_path,
					file.name,
				),
				{
					recursive: true,
				},
			);
		}));
	}

	/**
	 * Copy the distribution files of the backend project to the docker dist folder
	 * @returns {Promise<void>} A promise that resolves when the files are copied
	 * @private
	 */
	private async copyDistributionFilesBE() {
		const resolution_path = resolve(this.flags.headless_folder as string, "dist/apps/aetheria-backend/src");

		const files = await readdir(
			resolution_path,
			{
				withFileTypes: true,
				encoding:      "utf-8",
				recursive:     true,
			},
		);

		const files_to_copy = files.filter((dirent) => dirent.isFile() && dirent.name.endsWith(".js"));

		await this.runFilesCopy(files_to_copy, resolution_path);
	}

	/**
	 * Copy the distribution files to the docker dist folder
	 * @returns {Promise<void>} A promise that resolves when the files are copied
	 * @private
	 */
	private async copyDistributionFiles() {
		this.log("Copying distribution files ...");

		await (this.args.image === "frontend" ? this.copyDistributionFilesFE() : this.copyDistributionFilesBE());

		this.log("Distribution files copied successfully");
	}

	/**
	 * Build the project using tsc or nx depending on the project type
	 * @returns {Promise<void>} A promise that resolves when the project is built
	 * @private
	 */
	private buildProject() {
		return new Promise<void>((ok, fail) => {
			this.log(`Building ${this.flags.project_folder} ...`);

			const child = this.args.project === "frontend"
				? spawn(
					"npx",
					[
						"nx",
						"run",
						"frontend:build:production",
					],
					{ cwd: this.flags.project_folder },
				)
				: spawn("tsc", { cwd: this.flags.project_folder });

			child.stderr.on("data", (data) => {
				this.warn(data.toString());
			});

			child.on("error", (err) => {
				this.safeError(err);
			});

			child.on("close", (code) => {
				if (code === 0) {
					this.log("Build successfully");
					ok();
				}
				else {
					this.error(`Build failed with code ${code}`);
					fail();
				}
			});
		});
	}

	/**
	 * Verify that the docker folder exists and contains all the required presets
	 * @returns {Promise<void>} A promise that resolves when the folder is verified
	 * @private
	 */
	private async verifyDockerFolderPresence() {
		try {
			const presets = await readdir(
				resolve(this.flags.project_folder as string, "docker"),
				{
					withFileTypes: true,
					encoding:      "utf-8",
				},
			);

			if (!presets.every((dirent) => dirent.isDirectory() && Build.available_presets.includes(dirent.name))) {
				this.error(
					`The docker folder does not contain all the required presets: ` +
					` ${Build.available_presets.join(", ")}`,
				);
			}

			this.docker_folder = resolve(
				this.flags.project_folder as string,
				"docker",
				this.args.image as string,
			);
		}
		catch (error: any) {
			this.logDebug(error.message);
			this.error(`The docker folder does not exist in '${this.flags.project_folder}'`);
		}
	}

	/**
	 * Request the missing parameters to the user
	 * @returns {Promise<boolean>} A promise that resolves when the parameters are set
	 * @private
	 */
	private async getMissingParameters() {
		await this.getProjectIfNotSet();
		await this.getProjectFolderIfNotSet();
		await this.getImageIfNotSet();
		await this.getVersionIfNotSet();

		return true;
	}

	/**
	 * Request the version if not defined
	 * @returns {Promise<void>} A promise that resolves when the version is set
	 * @private
	 */
	private async getVersionIfNotSet() {
		if (this.flags.version && semver.valid(this.flags.version)) {
			return;
		}

		const inquirer = require("inquirer");

		const answers = await inquirer.prompt([
			{
				type:     "input",
				name:     "version",
				message:  "What version of the image is this?",
				default:  "0.0.0",
				validate: (input: string) => {
					if (semver.valid(input)) {
						return true;
					}

					return "Please enter a valid version";
				},
			},
		]);

		this.flags.version = answers.version;
	}

	/**
	 * Request the project folder if not defined
	 * @returns {Promise<boolean>} A promise that resolves when the project folder is set
	 * @private
	 */
	private async getProjectFolderIfNotSet() {
		if (this.flags.project_folder) {
			return true;
		}

		const inquirer = require("inquirer");

		const answers = await inquirer.prompt([
			{
				type:     "input",
				name:     "project_folder",
				message:  "Where is the project located?",
				default:  this.args.project === "backend" ? "../headless" : "../frontend",
				validate: (input: string) => {
					if (input.length === 0) {
						return "Please enter a valid path";
					}

					return true;
				},
			},
		]);

		this.flags.project_folder = answers.project_folder;

		return true;
	}

	/**
	 * Request the project type if not defined
	 * @returns {Promise<boolean>} A promise that resolves when the project type is set
	 * @private
	 */
	private async getProjectIfNotSet() {
		if (this.args.project) {
			return true;
		}

		const inquirer = require("inquirer");

		const answers = await inquirer.prompt([
			{
				type:    "list",
				name:    "project",
				message: "Which project should be built?",
				options: [
					"backend",
					"frontend",
				],
			},
		]);

		this.args.project = answers.project;

		return true;
	}

	/**
	 * Request the image name if not defined
	 * @returns {Promise<void>} A promise that resolves when the image name is set
	 * @private
	 */
	private async getImageIfNotSet() {
		if (this.args.image) {
			return;
		}

		const inquirer = require("inquirer");

		const answers = await inquirer.prompt([
			{
				type:    "list",
				name:    "image",
				message: "Which image do you want to build?",
				choices: Build.available_presets,
			},
		]);

		this.args.image = answers.image;
	}
}
