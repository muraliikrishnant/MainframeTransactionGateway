      *> ============================================================
      *> INTEREST.cob
      *> Batch program: computes one day's simple interest on a single
      *> account balance. In a real mainframe shop this would be a
      *> JCL-scheduled COBOL batch job run across the whole account
      *> file during the overnight batch window; here it is invoked
      *> once per account by the "batch-scheduler" service, which
      *> plays the role of the job scheduler (cron stands in for JES2).
      *> ============================================================
       IDENTIFICATION DIVISION.
       PROGRAM-ID. INTEREST.

       DATA DIVISION.
       WORKING-STORAGE SECTION.

       01  WS-INPUT-LINE        PIC X(60).
       01  WS-BALANCE           PIC 9(15).
       01  WS-RATE-BASIS-POINTS PIC 9(5).
       01  WS-INTEREST-AMOUNT   PIC 9(15).
       01  WS-NEW-BALANCE       PIC 9(15).

      *> intermediate working fields for the basis-point calculation
       01  WS-NUMERATOR         PIC 9(18).
       01  WS-DENOMINATOR       PIC 9(9) VALUE 1000000.

       PROCEDURE DIVISION.

       MAIN-LOGIC.
           PERFORM READ-INPUT
           PERFORM CALCULATE-INTEREST
           PERFORM WRITE-OUTPUT
           STOP RUN.

       READ-INPUT.
      *> Input line format: BALANCE|RATEBASISPOINTS
      *> e.g. "500000|100" = $5000.00 balance, 1.00% annualized,
      *> applied here as a flat daily accrual for demo purposes.
           ACCEPT WS-INPUT-LINE FROM CONSOLE
           UNSTRING WS-INPUT-LINE DELIMITED BY "|"
               INTO WS-BALANCE WS-RATE-BASIS-POINTS.

       CALCULATE-INTEREST.
      *> interest = balance * rateBasisPoints / 1,000,000
      *> (basis points are hundredths of a percent; dividing by 1,000,000
      *>  converts basis points directly to a cents-safe daily fraction)
           COMPUTE WS-NUMERATOR = WS-BALANCE * WS-RATE-BASIS-POINTS
           COMPUTE WS-INTEREST-AMOUNT = WS-NUMERATOR / WS-DENOMINATOR
           COMPUTE WS-NEW-BALANCE = WS-BALANCE + WS-INTEREST-AMOUNT.

       WRITE-OUTPUT.
      *> Output line format: INTERESTAMOUNT|NEWBALANCE
           DISPLAY WS-INTEREST-AMOUNT "|" WS-NEW-BALANCE.
