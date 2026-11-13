import { useReducedMotion } from "motion/react";
import { BorderBeam } from "../ui/border-beam";

/**
 * A light that travels round the border of whatever is live right now (Magic UI's border beam): a recipe following the
 * wrist, a model detecting a gesture. Put it inside an element that is `relative`, clips its overflow and has rounded
 * corners. It is decoration only, and is left out for anyone who asked for reduced motion.
 */
export function LiveBeam({ active }: { active: boolean }) {
  const still = useReducedMotion();
  if (!active || still) return null;
  return <BorderBeam size={90} duration={4} borderWidth={2} colorFrom="var(--yellow, #ffd400)" colorTo="var(--green, #36d399)" />;
}
