/**
 * GLSL colour conversion helpers adapted from liquid-glass-studio
 * src/shaders/lib/color.glsl at d13c3e53813ebc1d8b52d878071b63212a550ebc.
 * Copyright (c) 2024 Charles Yin. MIT licensed; see ../NOTICE.md.
 */
export const colorLib = `vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

const vec3 D65_WHITE = vec3(0.95045592705, 1.0, 1.08905775076);
vec3 WHITE = D65_WHITE;
const mat3 RGB_TO_XYZ_M = mat3(0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505);
const mat3 XYZ_TO_RGB_M = mat3(3.2406255, -1.537208, -0.4986286, -0.9689307, 1.8757561, 0.0415175, 0.0557101, -0.2040211, 1.0569959);
float UNCOMPAND_SRGB(float a) { return a > 0.04045 ? pow((a + 0.055) / 1.055, 2.4) : a / 12.92; }
float COMPAND_RGB(float a) { return a <= 0.0031308 ? 12.92 * a : 1.055 * pow(a, 0.41666666666) - 0.055; }
vec3 SRGB_TO_RGB(vec3 srgb) { return vec3(UNCOMPAND_SRGB(srgb.x), UNCOMPAND_SRGB(srgb.y), UNCOMPAND_SRGB(srgb.z)); }
vec3 RGB_TO_SRGB(vec3 rgb) { return vec3(COMPAND_RGB(rgb.x), COMPAND_RGB(rgb.y), COMPAND_RGB(rgb.z)); }
vec3 RGB_TO_XYZ(vec3 rgb) { return rgb * RGB_TO_XYZ_M; }
vec3 SRGB_TO_XYZ(vec3 srgb) { return RGB_TO_XYZ(SRGB_TO_RGB(srgb)); }
float XYZ_TO_LAB_F(float x) { return x > 0.00885645167 ? pow(x, 0.333333333) : 7.78703703704 * x + 0.13793103448; }
vec3 XYZ_TO_LAB(vec3 xyz) {
  vec3 s = xyz / WHITE;
  s = vec3(XYZ_TO_LAB_F(s.x), XYZ_TO_LAB_F(s.y), XYZ_TO_LAB_F(s.z));
  return vec3(116.0 * s.y - 16.0, 500.0 * (s.x - s.y), 200.0 * (s.y - s.z));
}
vec3 SRGB_TO_LAB(vec3 srgb) { return XYZ_TO_LAB(SRGB_TO_XYZ(srgb)); }
vec3 LAB_TO_LCH(vec3 Lab) { return vec3(Lab.x, sqrt(dot(Lab.yz, Lab.yz)), atan(Lab.z, Lab.y) * 57.2957795131); }
vec3 SRGB_TO_LCH(vec3 srgb) { return LAB_TO_LCH(SRGB_TO_LAB(srgb)); }
vec3 XYZ_TO_RGB(vec3 xyz) { return xyz * XYZ_TO_RGB_M; }
vec3 RGB_TO_SRGB_VEC(vec3 rgb) { return vec3(COMPAND_RGB(rgb.x), COMPAND_RGB(rgb.y), COMPAND_RGB(rgb.z)); }
vec3 XYZ_TO_SRGB(vec3 xyz) { return RGB_TO_SRGB_VEC(XYZ_TO_RGB(xyz)); }
float LAB_TO_XYZ_F(float x) { return x > 0.206897 ? x * x * x : 0.12841854934 * (x - 0.137931034); }
vec3 LAB_TO_XYZ(vec3 Lab) {
  float w = (Lab.x + 16.0) / 116.0;
  return WHITE * vec3(LAB_TO_XYZ_F(w + Lab.y / 500.0), LAB_TO_XYZ_F(w), LAB_TO_XYZ_F(w - Lab.z / 200.0));
}
vec3 LAB_TO_SRGB(vec3 lab) { return XYZ_TO_SRGB(LAB_TO_XYZ(lab)); }
vec3 LCH_TO_LAB(vec3 LCh) { return vec3(LCh.x, LCh.y * cos(LCh.z * 0.01745329251), LCh.y * sin(LCh.z * 0.01745329251)); }
vec3 LCH_TO_SRGB(vec3 lch) { return LAB_TO_SRGB(LCH_TO_LAB(lch)); }
`
