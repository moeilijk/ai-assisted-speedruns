// BizHawk emulator (generic, with game profiles): a stub game plugin. Nothing is implemented yet; `aas configure` refuses a stub, and
// connect() says so. The planned route, its license and its risks are in README.md next to this file.
const NOT_YET = "bizhawk is a stub game plugin: nothing is implemented yet (see games/bizhawk/README.md)";

export default {
  id: "bizhawk",
  name: "BizHawk emulator (generic, with game profiles)",
  version: "0.0.0",
  stub: true,
  ends: [{id: "end", label: "To be defined", final: true}],
  endpoints: [],
  env: [],
  documentation: `# BizHawk emulator (generic, with game profiles)\n\n${NOT_YET}.\n`,
  async connect() {
    throw new Error(NOT_YET);
  },
};
