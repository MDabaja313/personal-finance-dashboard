import "server-only";

import { mockCategories } from "@/lib/mock";
import type { Category } from "@/lib/types";

export async function getCategories(): Promise<Category[]> {
  return [...mockCategories];
}
