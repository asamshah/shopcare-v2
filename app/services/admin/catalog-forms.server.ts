/**
 * Form reading and view data shared by the warranty policy, product group,
 * Care plan and trade-in program screens (new + edit render the same form;
 * an invalid save re-renders it with the merchant's values and the model's
 * messages, Rails `render :new, status: :unprocessable_entity`).
 */
import { data } from "react-router";
import prisma from "../../db.server";
import { ValidationError } from "../../models/validation.server";
import { orNotFound } from "./context.server";
import { parse, zOptionalId } from "./form.server";

/** A product group chosen in a form (blank = all products); only this shop's, else 404. */
export async function chosenGroupId(shopId: number, raw: string): Promise<number | null> {
  const id = parse(zOptionalId, raw);
  if (id === null) return null;
  orNotFound(await prisma.productGroup.findFirst({ where: { id, shopId }, select: { id: true } }));
  return id;
}

/** 422 with the form's values and messages, for the component to re-render. */
export function invalid<V, E extends object = object>(errors: string[], values: V, extra?: E) {
  return data({ errors, values, ...(extra ?? ({} as E)) }, { status: 422 });
}

/** Runs a save; a ValidationError becomes the 422 re-render (with `extra`, e.g. a terms preview). */
export async function saveOr422<V, E extends object = object>(
  values: V,
  save: () => Promise<Response>,
  extra?: E,
) {
  try {
    return await save();
  } catch (error) {
    if (error instanceof ValidationError) return invalid(error.errors.fullMessages(), values, extra);
    throw error;
  }
}
