"""Small runnable regressions for the nontrivial transforms used by this package."""
import unittest
import numpy as np
from common import effective,spans
from analyze import classification,metrics_from_cm

class Checks(unittest.TestCase):
    def test_label_override(self):
        self.assertEqual(effective('pinch_in',''),'pinch_in')
        self.assertEqual(effective('pinch_in','-'),'')
        self.assertEqual(effective('pinch_in','pinch_out'),'pinch_out')
        self.assertEqual(effective('pinch_in','left_out'),'left_out')
    def test_band_boundaries(self):
        self.assertEqual(spans([0,1,2,3],['','pinch_in','pinch_in','pinch_hold']),[(0.,1.,''),(1.,3.,'pinch_in'),(3.,3.,'pinch_hold')])
        self.assertEqual(spans([],[]),[])
    def test_perfect_confusion(self):
        got=classification(np.arange(4),np.eye(4))
        self.assertEqual(got['confusion_matrix'],np.eye(4,dtype=int).tolist())
        self.assertEqual(got['macro_f1'],1.)
    def test_background_dominance(self):
        got=metrics_from_cm([[100,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]])
        self.assertEqual(got['accuracy'],1.)
        self.assertEqual(got['macro_f1'],.25)
    def test_reject_invalid_probabilities(self):
        with self.assertRaises(AssertionError):classification(np.array([0]),np.array([[.2,.2,.2,.2]]))
        with self.assertRaises(AssertionError):classification(np.array([4]),np.array([[1.,0,0,0]]))

if __name__=='__main__':unittest.main()
