/** @type {import("tailwindcss").Config} */
module.exports = {
	content: [],
	corePlugins: {
		preflight: true,
	},
	theme: {
		extend: {},
	},
	plugins: [
		require("@tailwindcss/typography"),
		require("@tailwindcss/forms"),
		require("@tailwindcss/aspect-ratio"),
	],
};
