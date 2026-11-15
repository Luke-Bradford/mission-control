import { protectedGlobShapeProblem } from "@mc/core";
import { z } from "zod";

const nonEmpty = z.string().min(1);
/** A repo-relative glob: no `/`, `./` or `~` start, no `..` segment, none of `{ [ ? ! , ( ) \\` or whitespace. */
export const areaGlob = nonEmpty.refine(
  (g) =>
    !g.startsWith("/") &&
    !g.startsWith("./") &&
    !g.startsWith("~") &&
    !g.split("/").includes("..") &&
    !/[{[?!,()\\\s]/.test(g),
  "must be a repo-relative glob without .. segments, a leading ~, whitespace or any of { [ ? ! , ( ) \\",
);
/** A `protected` entry: an area glob in the characters core accepts. */
export const protectedGlob = areaGlob
  .refine(
    (g) => /^[A-Za-z0-9._/*@+-]+$/.test(g),
    "must hold only letters, digits and . _ / * @ + -",
  )
  .superRefine((g, ctx) => {
    const problem = protectedGlobShapeProblem(g);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });
