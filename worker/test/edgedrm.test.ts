import { describe, expect, it } from "vitest";
import { secMsGecV2 } from "../src/edgedrm";

// Golden values from Python edge-tts generate_sec_ms_gec_v2()
describe("Sec-MS-GEC v2 matches Python edge-tts", () => {
  it.each([
    [1794657000, "197D44409B7B543D-C476310F33E30D15EB7C9DF26EB272C1E4EEC6920F58CB349396CA296B80B18F"],
    [1700000000, "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2"],
    [1800000123.5, "99E54519B490BE5C-E162DB0977FBDCB9B86DD8148BF1BCDC3C0303176CE39852A42B415935C20654"],
  ])("t=%s", (t, expected) => expect(secMsGecV2(t)).toBe(expected));
});
