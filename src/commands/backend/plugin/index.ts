import { BaseCommand } from "../../../base";

export class Index extends BaseCommand<typeof Index> {
	static summary = "Interact with backend";

	public async run() {
		await (this.ctor as typeof Index).run([ "--help" ]);
	}
}
