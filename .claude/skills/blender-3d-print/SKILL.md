# Blender 3D Print Modeling Skill

## Purpose
Create 3D-printable models in Blender via the MCP, with focus on:
- Print-in-place mechanisms (hinges, articulations)
- Proper tolerances for FDM/resin printing
- STL/3MF export with manifold mesh verification

## Key Parameters

### Print-in-Place Tolerances
- **FDM hinge gap**: 0.3mm (PLA), 0.25mm (PETG), 0.35mm (ABS)
- **Snap-fit clearance**: 0.15-0.2mm per side
- **Magnet pocket clearance**: 0.2mm diameter, 0.1mm depth
- **Minimum wall thickness**: 0.8mm (2 perimeters at 0.4mm nozzle)
- **Minimum feature size**: 0.4mm (nozzle diameter)

### Common Magnet Sizes
- 5mm x 3mm disc (most common for fridge magnets)
- 6mm x 2mm disc
- 10mm x 3mm disc
- 3mm x 3mm cube

### Hinge Design Principles
1. Pin-and-socket: cylindrical pin inside a C-shaped or full-circle socket
2. Gap must be consistent around the entire rotation axis
3. Pin should have slight chamfer for easier break-free
4. Socket should wrap >180° to prevent pin from falling out
5. Alternate pin/socket segments along the hinge axis (knuckle joint)

## Blender Python Workflow

### Setup
```python
import bpy
# Set units to millimeters
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.scene.unit_settings.scale_length = 0.001
bpy.context.scene.unit_settings.length_unit = 'MILLIMETERS'
```

### Mesh Verification
```python
import bmesh

def check_manifold(obj):
    """Check if mesh is watertight (manifold)"""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    non_manifold = [e for e in bm.edges if not e.is_manifold]
    bm.free()
    return len(non_manifold) == 0
```

### STL Export
```python
bpy.ops.wm.stl_export(
    filepath="/path/to/model.stl",
    export_selected_objects=True,
    ascii_format=False,  # Binary is smaller
    apply_modifiers=True,
    global_scale=1.0,
)
```

### Boolean Operations (for pockets, holes)
```python
def boolean_subtract(target, cutter):
    mod = target.modifiers.new(name="Bool", type='BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.object = cutter
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier="Bool")
    bpy.data.objects.remove(cutter, do_unlink=True)
```

## Print Settings Recommendations
- **Infill**: 15-20% for decorative, 40%+ for functional
- **Layer height**: 0.2mm standard, 0.12mm for fine detail
- **Supports**: None for print-in-place (by design)
- **Material**: PETG for flexible hinges, PLA for rigid parts
- **Speed**: Slow (30-40mm/s) for print-in-place gaps

## Common Patterns

### Articulating Chain
- Alternating link segments with captive pins
- Each link rotates ~90° on its axis
- Gap: 0.3mm for PLA at 0.2mm layer height

### Leaf/Organic Shapes
- Use spline curves converted to mesh
- Add subdivision surface for smoothness
- Veins as beveled curves (bevel_depth 0.2-0.5mm)

### Modular Snap-Fit System
- Male: cylinder with spherical bump (0.3mm oversize)
- Female: matching socket with entry chamfer
- Designed to flex slightly during insertion then lock
