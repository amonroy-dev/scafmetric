"""Solve scaffold models with OpenSees and report the vertical reaction at each base.

    python solve.py <folder of *.model.json>

Writes <name>.reactions.json beside each model. Feet and pounds throughout.

Each model is solved three ways, for dead and for live load separately:

  pinned   Ledgers and deck strips pin-ended, braces as weight only. Every
           load has one path to the ground, so the reactions are fixed by
           equilibrium alone and no stiffness enters. This is the load path a
           tributary takeoff assumes; the builder's leg loads must equal these.

  braced   The same, with the diagonal braces added as axial members. The
           standards shorten under load and the braces resist it, so a little
           load moves between legs. Shows what bracing stiffness does.

  rigid    Ledgers welded to the standards (no end releases), braces in,
           bases pinned. Ledgers running over a standard act as continuous
           beams. This is the other end of the range from "pinned"; a real
           wedge-head joint sits between the two.
"""
import glob
import json
import math
import os
import sys

import openseespy.opensees as ops

PSI_TO_PSF = 144.0
E = 29_000_000.0 * PSI_TO_PSF
G = 11_200_000.0 * PSI_TO_PSF


def tube(od_in, wall_in):
    """Area (ft2), second moment (ft4) and torsion constant (ft4) of a round tube."""
    inner = od_in - 2 * wall_in
    area = math.pi / 4 * (od_in ** 2 - inner ** 2) / 144.0
    inertia = math.pi / 64 * (od_in ** 4 - inner ** 4) / 20736.0
    return area, inertia, 2 * inertia


TUBE = tube(1.9, 0.12)
# A deck strip only has to pass its load to its two ends. Its bending stiffness
# cannot matter (it is pin-ended), and it is given almost no torsional stiffness
# so that it cannot tie the rotations of the two ledgers it rests on together.
STRIP = (0.02, 1.0e-4, 1.0e-10)

VARIANTS = ('pinned', 'braced', 'rigid')


def build(model, variant):
    ops.wipe()
    ops.model('basic', '-ndm', 3, '-ndf', 6)
    for i, (x, y, z) in enumerate(model['nodes']):
        ops.node(i + 1, x, y, z)

    ops.geomTransf('Linear', 1, 1.0, 0.0, 0.0)   # vertical members
    ops.geomTransf('Linear', 2, 0.0, 0.0, 1.0)   # everything else
    ops.uniaxialMaterial('Elastic', 1, E)

    framed = set()
    for member in model['members']:
        if member['kind'] == 'ledger':
            framed.update(member['chain'])

    tag = 0
    for member in model['members']:
        area, inertia, torsion = STRIP if member['kind'] == 'strip' else TUBE
        pin_ended = member['pinned'] and not (variant == 'rigid' and member['kind'] == 'ledger')
        chain = member['chain']
        for k in range(len(chain) - 1):
            a, b = chain[k], chain[k + 1]
            ax, ay, az = model['nodes'][a]
            bx, by, bz = model['nodes'][b]
            length = math.dist((ax, ay, az), (bx, by, bz))
            vertical = abs(bz - az) > 0.99 * length
            release = 0
            if pin_ended:
                release = (1 if k == 0 else 0) + (2 if k == len(chain) - 2 else 0)
            tag += 1
            args = [tag, a + 1, b + 1, area, E, G, torsion, inertia, inertia, 1 if vertical else 2]
            if release:
                args += ['-releasez', release, '-releasey', release]
            ops.element('elasticBeamColumn', *args)

    if variant != 'pinned':
        for brace in model['braces']:
            tag += 1
            a, b = brace['ends']
            ops.element('truss', tag, a + 1, b + 1, TUBE[0], 1)

    for support in model['supports']:
        node = support['node'] + 1
        # A pinned base needs the frame to hold the standard up; one with no
        # ledger on it has nothing to lean on and is held rigidly instead.
        chain = next(m['chain'] for m in model['members'] if m['kind'] == 'standard' and m['id'] == support['leg'])
        leans = any(n in framed for n in chain)
        if variant == 'rigid' and leans:
            ops.fix(node, 1, 1, 1, 0, 0, 0)
        else:
            ops.fix(node, 1, 1, 1, 1, 1, 1)


def solve(model, variant, case):
    build(model, variant)
    ops.timeSeries('Constant', 1)
    ops.pattern('Plain', 1, 1)
    for node, pounds in model['loads'][case]:
        ops.load(node + 1, 0.0, 0.0, -pounds, 0.0, 0.0, 0.0)
    ops.system('UmfPack')
    ops.numberer('RCM')
    ops.constraints('Plain')
    ops.integrator('LoadControl', 1.0)
    ops.algorithm('Linear')
    ops.analysis('Static')
    status = ops.analyze(1)
    if status != 0:
        return None
    ops.reactions()
    return {support['leg']: ops.nodeReaction(support['node'] + 1)[2] for support in model['supports']}


def main(folder):
    for path in sorted(glob.glob(os.path.join(folder, '*.model.json'))):
        with open(path, encoding='utf-8') as handle:
            model = json.load(handle)
        result = {'opensees': ops.version(), 'variants': {}}
        for variant in VARIANTS:
            if variant != 'pinned' and variant != 'rigid' and not model['braces']:
                continue  # nothing to add
            result['variants'][variant] = {case: solve(model, variant, case) for case in ('dead', 'live')}
        out = path.replace('.model.json', '.reactions.json')
        with open(out, 'w', encoding='utf-8') as handle:
            json.dump(result, handle, indent=1)
        print('solved', os.path.basename(path))


if __name__ == '__main__':
    main(sys.argv[1])
