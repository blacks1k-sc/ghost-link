export type PlatformClass =
  | "NAVAL_SURFACE"
  | "SUBMARINE"
  | "AIRBASE_FIXED_WING"
  | "AIRBASE_STEALTH"
  | "AIRBORNE_CARRIER_AIRCRAFT"
  | "FORWARD_CAS_AIRCRAFT";

export type LaunchProfile =
  | "STANDOFF_CRUISE"
  | "AIR_LAUNCHED_STANDOFF"
  | "AIR_LAUNCHED_DIRECT"
  | "CARRIER_STRIKE";

export interface WeaponDoctrineEntry {
  id: string;
  displayName: string;
  compatiblePlatforms: PlatformClass[];
  launchProfile: LaunchProfile;
  minStandoffKm: number;
  maxRangeKm: number;
  requiresForwardIngress: boolean;
  pathLegs: 1 | 2;
  ingressColor: string;
  flightColor: string;
}

export const WEAPON_DOCTRINE_MATRIX: Record<string, WeaponDoctrineEntry> = {
  tomahawk_block5: {
    id: "tomahawk_block5",
    displayName: "Tomahawk Block V",
    compatiblePlatforms: ["NAVAL_SURFACE", "SUBMARINE"],
    launchProfile: "STANDOFF_CRUISE",
    minStandoffKm: 0,
    maxRangeKm: 1850,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#00bfff",
    flightColor: "#00bfff",
  },
  jassm_er: {
    id: "jassm_er",
    displayName: "JASSM-ER",
    compatiblePlatforms: ["AIRBASE_FIXED_WING", "AIRBASE_STEALTH", "AIRBORNE_CARRIER_AIRCRAFT"],
    launchProfile: "AIR_LAUNCHED_STANDOFF",
    minStandoffKm: 0,
    maxRangeKm: 980,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#ffaa00",
    flightColor: "#ffaa00",
  },
  lrasm: {
    id: "lrasm",
    displayName: "LRASM",
    compatiblePlatforms: ["NAVAL_SURFACE", "AIRBASE_FIXED_WING", "AIRBORNE_CARRIER_AIRCRAFT"],
    launchProfile: "STANDOFF_CRUISE",
    minStandoffKm: 0,
    maxRangeKm: 930,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#ffaa00",
    flightColor: "#ffaa00",
  },
  storm_shadow: {
    id: "storm_shadow",
    displayName: "Storm Shadow / SCALP",
    compatiblePlatforms: ["AIRBASE_FIXED_WING", "AIRBASE_STEALTH"],
    launchProfile: "AIR_LAUNCHED_STANDOFF",
    minStandoffKm: 0,
    maxRangeKm: 560,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#ff6600",
    flightColor: "#ff6600",
  },
  atacms_m39a1: {
    id: "atacms_m39a1",
    displayName: "ATACMS M39A1",
    compatiblePlatforms: ["FORWARD_CAS_AIRCRAFT"],
    launchProfile: "AIR_LAUNCHED_DIRECT",
    minStandoffKm: 0,
    maxRangeKm: 300,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#ffaa00",
    flightColor: "#ffaa00",
  },
  brahmos_a: {
    id: "brahmos_a",
    displayName: "BrahMos-A",
    compatiblePlatforms: ["AIRBASE_FIXED_WING"],
    launchProfile: "AIR_LAUNCHED_STANDOFF",
    minStandoffKm: 0,
    maxRangeKm: 450,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#ffaa00",
    flightColor: "#ffaa00",
  },
  kh_101: {
    id: "kh_101",
    displayName: "Kh-101",
    compatiblePlatforms: ["AIRBASE_FIXED_WING", "AIRBASE_STEALTH"],
    launchProfile: "AIR_LAUNCHED_STANDOFF",
    minStandoffKm: 0,
    maxRangeKm: 5500,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#ff6600",
    flightColor: "#ff6600",
  },
  kinzhal: {
    id: "kinzhal",
    displayName: "Kinzhal",
    compatiblePlatforms: ["AIRBASE_FIXED_WING"],
    launchProfile: "AIR_LAUNCHED_DIRECT",
    minStandoffKm: 0,
    maxRangeKm: 2000,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#ffaa00",
    flightColor: "#ffaa00",
  },
  harpoon: {
    id: "harpoon",
    displayName: "Harpoon",
    compatiblePlatforms: ["NAVAL_SURFACE", "AIRBASE_FIXED_WING", "AIRBORNE_CARRIER_AIRCRAFT"],
    launchProfile: "STANDOFF_CRUISE",
    minStandoffKm: 0,
    maxRangeKm: 280,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#00bfff",
    flightColor: "#00bfff",
  },
  scalp_naval: {
    id: "scalp_naval",
    displayName: "SCALP Naval",
    compatiblePlatforms: ["NAVAL_SURFACE", "SUBMARINE"],
    launchProfile: "STANDOFF_CRUISE",
    minStandoffKm: 0,
    maxRangeKm: 1000,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#00bfff",
    flightColor: "#00bfff",
  },
  df_26: {
    id: "df_26",
    displayName: "DF-26",
    compatiblePlatforms: ["FORWARD_CAS_AIRCRAFT"],
    launchProfile: "AIR_LAUNCHED_DIRECT",
    minStandoffKm: 0,
    maxRangeKm: 4000,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#ffaa00",
    flightColor: "#ffaa00",
  },
  iskander_m: {
    id: "iskander_m",
    displayName: "Iskander-M",
    compatiblePlatforms: ["FORWARD_CAS_AIRCRAFT"],
    launchProfile: "AIR_LAUNCHED_DIRECT",
    minStandoffKm: 0,
    maxRangeKm: 500,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#ffaa00",
    flightColor: "#ffaa00",
  },
  yj_18: {
    id: "yj_18",
    displayName: "YJ-18",
    compatiblePlatforms: ["NAVAL_SURFACE", "SUBMARINE"],
    launchProfile: "STANDOFF_CRUISE",
    minStandoffKm: 0,
    maxRangeKm: 540,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#00bfff",
    flightColor: "#00bfff",
  },
  taurus_kepd_350: {
    id: "taurus_kepd_350",
    displayName: "TAURUS KEPD 350",
    compatiblePlatforms: ["AIRBASE_FIXED_WING", "AIRBASE_STEALTH"],
    launchProfile: "AIR_LAUNCHED_STANDOFF",
    minStandoffKm: 0,
    maxRangeKm: 500,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#ff6600",
    flightColor: "#ff6600",
  },
  p_800_oniks: {
    id: "p_800_oniks",
    displayName: "P-800 Oniks",
    compatiblePlatforms: ["NAVAL_SURFACE", "SUBMARINE"],
    launchProfile: "STANDOFF_CRUISE",
    minStandoffKm: 0,
    maxRangeKm: 600,
    requiresForwardIngress: false,
    pathLegs: 1,
    ingressColor: "#00bfff",
    flightColor: "#00bfff",
  },
};

export function getDoctrineEntry(weaponId: string): WeaponDoctrineEntry | null {
  return WEAPON_DOCTRINE_MATRIX[weaponId] ?? null;
}

export function isNavalWeapon(weaponId: string): boolean {
  const entry = WEAPON_DOCTRINE_MATRIX[weaponId];
  if (!entry) return false;
  return entry.compatiblePlatforms.every(
    (p) => p === "NAVAL_SURFACE" || p === "SUBMARINE",
  );
}
