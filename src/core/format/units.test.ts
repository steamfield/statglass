import { displayUnits } from "./units";

describe("displayUnits", () => {
  it("defaults to MB/s, GB and °F before settings arrive", () => {
    expect(displayUnits(null)).toEqual({
      rate: "MBps",
      bytes: "GB",
      temperature: "F",
    });
  });

  it("maps each Units setting to its formatter unit", () => {
    expect(
      displayUnits({
        network: "bits_per_sec",
        memory: "binary",
        temperature: "celsius",
      })
    ).toEqual({ rate: "Mbps", bytes: "GiB", temperature: "C" });
    expect(
      displayUnits({
        network: "bytes_per_sec",
        memory: "decimal",
        temperature: "fahrenheit",
      })
    ).toEqual({ rate: "MBps", bytes: "GB", temperature: "F" });
  });
});
