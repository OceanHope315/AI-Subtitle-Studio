"""Automatic subtitle-region estimation."""

from .estimator import RoiEstimate, estimate_roi_from_observations, estimate_video_roi

__all__ = ["RoiEstimate", "estimate_roi_from_observations", "estimate_video_roi"]
