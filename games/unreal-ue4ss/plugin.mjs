// Unreal Engine games through UE4SS (generic bridge): a stub game plugin. Nothing is implemented yet; `aas configure` refuses a stub,
// and connect() says so. The planned route, its license and its risks are in README.md next to this file.
const NOT_YET = "unreal_ue4ss is a stub game plugin: nothing is implemented yet (see games/unreal-ue4ss/README.md)";

export default {
  id: "unreal_ue4ss",
  name: "Unreal Engine games through UE4SS (generic bridge)",
  version: "0.0.0",
  stub: true,
  ends: [{id: "end", label: "To be defined", final: true}],
  endpoints: [],
  env: [],
  documentation: `# Unreal Engine games through UE4SS (generic bridge)\n\n${NOT_YET}.\n`,
  async connect() {
    throw new Error(NOT_YET);
  },
};
