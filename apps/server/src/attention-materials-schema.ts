/** The arguments FLIGHT and a seat give to attach a story of pictures to a question. */

import { z } from "zod";

const MaterialImageArg = z.strictObject({
  path: z.string().min(1).max(300),
  caption: z.string().min(1).max(300),
});
const MaterialSectionArg = z.strictObject({
  heading: z.string().min(1).max(200),
  text: z.string().max(4000).optional(),
  images: z.array(MaterialImageArg).max(12).optional(),
  comparison: z.enum(["before-after", "options"]).optional(),
  get children() {
    return z.array(MaterialSectionArg).max(12).optional();
  },
});

/** The story itself: the commit its images are committed at, a label and ordered sections. */
export const MaterialsStoryShape = {
  sourceCommit: z.string().min(1).max(64),
  label: z.string().min(1).max(300),
  sections: z.array(MaterialSectionArg).min(1).max(40),
};

/** Pictures for a brief option, by its id: only FLIGHT, who writes the brief, names them. */
export const MaterialsOptionImages = z
  .array(
    z.strictObject({
      optionId: z.string().min(1).max(200),
      imagePaths: z.array(z.string().min(1).max(300)).min(1).max(12),
    }),
  )
  .max(8);
