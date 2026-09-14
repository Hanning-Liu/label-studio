import "./core/feature-flags";
import "@hanning/frontend/adapters/boundary";
import "./assets/styles/global.scss";
import { LabelStudio } from "./LabelStudio";

window.LabelStudio = LabelStudio;

export default LabelStudio;

export { LabelStudio };
