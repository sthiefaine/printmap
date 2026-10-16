"""Offline derivation tests. Requires the script's numpy/shapely environment."""
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/derive-arbre-blanc-lidar.py'
spec = importlib.util.spec_from_file_location('arbre_derivation', SCRIPT)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
np = d.np


def plane(z=20.):
    axis = np.arange(-1.5, 1.501, .25)
    return np.array([(x, y, z) for x in axis for y in axis])


class HorizontalEvidence(unittest.TestCase):
    def test_horizontal_groups_survive_but_a_sliced_vertical_wall_is_not_a_plate(self):
        horizontal = plane()
        classes = np.full(len(horizontal), 6)
        selected, _ = d.horizontal_returns(horizontal[:, :2], horizontal[:, 2], classes, np.ones(len(classes), bool))
        self.assertTrue(selected[len(classes) // 2])
        # Candidate Zs are narrow, but the fitting input keeps every wall Z.
        wall = np.array([(0., y, z) for y in np.arange(-1.5, 1.501, .25)
                         for z in np.arange(18., 22.001, .25)])
        candidates = abs(wall[:, 2] - 20) <= .2
        selected, _ = d.horizontal_returns(wall[:, :2], wall[:, 2], np.full(len(wall), 6), candidates)
        self.assertFalse(selected.any())

    def test_an_outlier_is_not_admitted_just_because_its_neighbours_have_a_horizontal_normal(self):
        points = np.r_[plane(), [[0., 0., 19.2]]]
        candidates = np.zeros(len(points), bool)
        candidates[-1] = True
        selected, _ = d.horizontal_returns(points[:, :2], points[:, 2], np.full(len(points), 6), candidates)
        self.assertFalse(selected[-1])

    def test_unclassified_horizontal_points_require_native_building_support(self):
        points = plane()
        classes = np.ones(len(points), int)
        candidates = np.zeros(len(points), bool)
        center = len(points) // 2
        candidates[center] = True
        selected, _ = d.horizontal_returns(points[:, :2], points[:, 2], classes, candidates)
        self.assertFalse(selected[center])
        classes[[center - 1, center + 1, center + 13]] = 6
        selected, details = d.horizontal_returns(points[:, :2], points[:, 2], classes, candidates)
        self.assertTrue(selected[center])
        self.assertGreaterEqual(details[center]['nativeBuildingSupport'], 3)

    def test_new_plane_recovery_preserves_every_historical_observation_and_witness(self):
        # Explicit synthetic control: a planar patch near a solid core.
        points = np.array([(x, y, d.LEVELS[0]) for x in np.arange(.25, 2.501, .25)
                           for y in np.arange(-1.25, 1.251, .25)])
        classes = np.full(len(points), 6)
        core = d.box(-2, -2, 0, 2)
        ground = d.box(-3, -3, 4, 4)
        old, _ = d.derive_legacy(points[:, :2], points[:, 2], classes, core, ground)
        new, _ = d.derive(points[:, :2], points[:, 2], classes, core, ground)
        self.assertEqual([p['elevationM'] for p in new], list(d.LEVELS))
        self.assertTrue(old[0]['polygons'])
        for before, after in zip(old, new):
            self.assertGreaterEqual(after['derivedAreaM2'] + .001, before['derivedAreaM2'])
            self.assertEqual(before['verificationPoints'], after['verificationPoints'][:len(before['verificationPoints'])])


if __name__ == '__main__':
    unittest.main()
