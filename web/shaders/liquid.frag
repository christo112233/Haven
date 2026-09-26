#version 300 es
precision highp float;

uniform sampler2D u_scene;
uniform sampler2D u_blurred_scene;
uniform vec2 u_resolution;
uniform float u_scale;
uniform vec4 u_rect;
uniform vec4 u_trail;
uniform float u_radius;
uniform vec4 u_tint;
uniform vec2 u_pointer;
uniform float u_activity;
uniform float u_time;
uniform float u_strength;
uniform float u_blur;
uniform float u_glow;
uniform float u_opacity;
uniform float u_cursor;
uniform float u_cursor_contrast;

// Upstream SDF helpers use these names. Shape composition is handled by the UI.
const float u_dpr = 1.0;
const int u_showShape1 = 0;
const float u_shapeWidth = 0.0;
const float u_shapeHeight = 0.0;
const float u_shapeRadius = 0.0;
const float u_shapeRoundness = 2.6;
const float u_mergeRate = 0.1;
#include "vendor/liquid-glass/sdf.glsl"
#include "vendor/liquid-glass/math.glsl"
#include "vendor/liquid-glass/color.glsl"

out vec4 fragColor;

float distanceToGlass(vec2 p) {
    float shape = roundedRectSDF(p, u_rect.xy, u_rect.z, u_rect.w, u_radius, 2.6);
    if (u_trail.z > 0.0) {
        float trailingShape = roundedRectSDF(p, u_trail.xy, u_trail.z, u_trail.w, u_trail.w * 0.5, 2.6);
        // The reference library uses a 24px group blend so nearby glass
        // silhouettes form a visible neck instead of two touching rims.
        shape = smin(shape, trailingShape, 24.0);
    }
    return shape;
}

vec3 sceneAt(vec2 p) {
    return texture(u_scene, p / (u_resolution / u_scale)).rgb;
}

vec3 softenedScene(vec2 p, float weight) {
    vec3 blurred = texture(u_blurred_scene, p / (u_resolution / u_scale)).rgb;
    return mix(sceneAt(p), blurred, weight);
}

void main() {
    vec2 p = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) / u_scale;
    float distance = distanceToGlass(p);
    float coverage = 1.0 - smoothstep(-0.7 / u_scale, 0.7 / u_scale, distance);
    if (coverage < 0.001) discard;

    vec2 normal = normalize(vec2(
        distanceToGlass(p + vec2(0.6, 0.0)) - distanceToGlass(p - vec2(0.6, 0.0)),
        distanceToGlass(p + vec2(0.0, 0.6)) - distanceToGlass(p - vec2(0.0, 0.6))
    ) + vec2(0.00001));
    float depth = max(0.0, -distance);
    float thickness = min(18.0, u_rect.w * 0.28);

    // Liquid Glass Studio's Snell refraction profile and chromatic dispersion.
    float ratio = clamp(1.0 - depth / thickness, 0.0, 1.0);
    float incident = safeAsin(ratio * ratio);
    float transmitted = safeAsin(sin(incident) / 1.45);
    float edgeFactor = -tan(transmitted - incident);
    vec2 offset = -normal * edgeFactor * (10.0 + u_activity * 5.0) * u_strength;
    vec3 refracted;
    float softness = u_blur * smoothstep(0.0, thickness * 0.5, depth);
    refracted.r = softenedScene(p + offset * 0.965, softness).r;
    refracted.g = softenedScene(p + offset, softness).g;
    refracted.b = softenedScene(p + offset * 1.035, softness).b;
    vec3 color = mix(refracted, u_tint.rgb, u_tint.a);

    float fresnel = pow(clamp(1.0 - depth / 5.0, 0.0, 1.0), 5.0);
    vec2 light = normalize(u_pointer - u_rect.xy + vec2(-80.0, -100.0));
    float angle = atan(normal.y, normal.x);
    float glare = pow(0.5 + 0.5 * dot(normal, light), 3.0);
    glare += 0.14 * pow(0.5 + 0.5 * sin(angle * 2.0 + u_time * 0.28), 8.0);
    float rim = exp(-depth * 2.4);
    vec3 fresnelLCH = SRGB_TO_LCH(mix(color, vec3(0.86, 0.97, 1.0), 0.25));
    fresnelLCH.x = min(115.0, fresnelLCH.x + 55.0);
    color = mix(color, clamp(LCH_TO_SRGB(fresnelLCH), 0.0, 1.0), fresnel * mix(0.3, 0.12, u_cursor) * u_glow);
    color = mix(color, vec3(0.92, 0.985, 1.0), rim * mix(0.25 + glare * 0.75, 0.08 + glare * 0.3, u_cursor) * u_glow);
    color += vec3(0.055, 0.08, 0.1) * glare * exp(-depth / 3.0) * u_activity * u_glow;
    float glint = pow(max(0.0, dot(normal, normalize(vec2(-0.75, -0.66)))), 8.0) * exp(-depth * 1.25);
    color = mix(color, vec3(0.95, 0.99, 1.0), glint * 0.26 * u_cursor);
    color = mix(color, vec3(0.07, 0.31, 0.43), rim * 0.48 * u_cursor_contrast);
    fragColor = vec4(color, coverage * u_opacity);
}
