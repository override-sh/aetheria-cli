import { Command } from "@oclif/core";
import { BaseCommand } from "./base";
// import { INestApplicationContext } from "@nestjs/common";
// import { bootstrap } from "@aetheria/support";

export abstract class BackendBaseCommand<T extends typeof Command> extends BaseCommand<T> {
	// protected app!: INestApplicationContext;

	public async init(): Promise<void> {
		await super.init();

		// this.app = await bootstrap();
	}
}
