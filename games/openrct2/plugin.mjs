// OpenRCT2 (RollerCoaster Tycoon 2 scenarios): a stub game plugin. Nothing is implemented yet; `aas configure` refuses a stub, and
// connect() says so. The planned route, its license and its risks are in README.md next to this file.
const NOT_YET = "openrct2 is a stub game plugin: nothing is implemented yet (see games/openrct2/README.md)";

export default {
  id: "openrct2",
  name: "OpenRCT2 (RollerCoaster Tycoon 2 scenarios)",
  version: "0.0.0",
  stub: true,
  ends: [{id: "end", label: "To be defined", final: true}],
  endpoints: [],
  env: [],
  documentation: `# OpenRCT2 (RollerCoaster Tycoon 2 scenarios)\n\n${NOT_YET}.\n`,
  async connect() {
    throw new Error(NOT_YET);
  },
};
