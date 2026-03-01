import { createAppRuntime } from "./main.js";
import {
  createPackingFeature,
  DEFAULT_PACK_ITEMS,
  sanitizePackItems
} from "./features/packing/index.js";

window.IcelandTripRuntimeLib = {
  createAppRuntime,
  createPackingFeature,
  DEFAULT_PACK_ITEMS,
  sanitizePackItems
};

