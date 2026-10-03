#pragma once
#include <string>

namespace faults {
// Linux link wrappers only: never linked into the app. No packet/key logging.
void arm(const std::string &operation, int milliseconds, int bursts = 1,
         int gap = 0, bool partial = false, int initialSkip = 0);
void coordinateWrite();
void waitBlocked();
int bursts();
int failures();
int ownershipViolations();
void disarm();
}
