/* The glow under the die: light on the PCB plane round the GPU, in the table's rest frame so it turns
   with the card. It sits between the board layer and the cooler layer, so the cooler covers it when the
   shroud is down and only a little shows between the fins. Dark: premultiplied light for a screen blend.
   Light: an ink solved from the colour the paper should show (saturated blue body, pale core). */
import { glslPose } from "../kit/gl.mjs";

export function glowFragment(die: number[], pcbZ: number) {
  const f = (v: number) => v.toFixed(3);
  return `${glslPose("Table")}
uniform float uLight;
uniform float uOn;
uniform float uLoad;
const vec2 DIE=vec2(${f(die[0])},${f(die[1])});
const float PCB_Z=${f(pcbZ)};
vec4 inkFor(vec3 seen){vec3 absorbed=1.-seen;float a=max(absorbed.r,max(absorbed.g,absorbed.b));return vec4(vec3(a)-absorbed,a);}
void main(){
  vec2 vb=viewOf(gl_FragCoord.xy);
  vec3 q=toTable(onFloor(vb,PCB_Z));
  vec2 d=q.xy-DIE;
  float r=length(max(abs(d)-vec2(9.),0.));
  float board=smoothstep(-118.,-108.,q.x)*(1.-smoothstep(78.,88.,q.x))*smoothstep(-50.,-42.,q.y)*(1.-smoothstep(42.,50.,q.y));
  float e=(exp(-r*r/(2.*14.*14.))*.85+exp(-r/30.)*.25)*board*uLoad;
  float lit=1.-exp(-1.6*e);
  lit*=1.-smoothstep(52.,70.,length(d));
  vec3 glow=vec3(.16,.52,1.)*lit+vec3(.55,.8,1.)*lit*lit*.5;
  vec4 dark=vec4(glow,max(glow.r,max(glow.g,glow.b)));
  vec3 seen=mix(vec3(1.),mix(vec3(.24,.52,.96),vec3(.82,.91,1.),smoothstep(.75,1.,lit)),.55*lit);
  vec4 light=inkFor(seen);
  vec4 ink=mix(dark,light,uLight)*uOn;
  ink.rgb=min(ink.rgb,vec3(ink.a));
  float n=(hash12(gl_FragCoord.xy)-.5)/255.*smoothstep(0.,1.5/255.,ink.a);
  gl_FragColor=clamp(ink+vec4(n),0.,1.);
}`;
}
