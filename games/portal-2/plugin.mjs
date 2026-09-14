// Portal 2 / Portal Stories: Mel / Aperture Tag: a stub game plugin. Nothing is implemented yet; `aas configure` refuses a stub, and
// connect() says so. The planned route, its license and its risks are in README.md next to this file.
const NOT_YET = "portal_2 is a stub game plugin: nothing is implemented yet (see games/portal-2/README.md)";

export default {
  id: "portal_2",
  name: "Portal 2 / Portal Stories: Mel / Aperture Tag",
  version: "0.0.0",
  stub: true,
  ends: [{id: "end", label: "To be defined", final: true}],
  endpoints: [],
  env: [],
  documentation: `# Portal 2 / Portal Stories: Mel / Aperture Tag\n\n${NOT_YET}.\n`,
  async connect() {
    throw new Error(NOT_YET);
  },
};
