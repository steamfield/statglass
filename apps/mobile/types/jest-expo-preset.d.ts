/**
 * The parts of jest-expo's preset that jest.config.cjs reads; the package
 * ships no types for it.
 */
declare module "jest-expo/jest-preset" {
  const preset: {
    moduleNameMapper: Record<string, string>;
    transformIgnorePatterns: string[];
  };
  export = preset;
}
