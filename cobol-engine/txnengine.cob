      *> ============================================================
      *> TXNENGINE.cob
      *> Simulates an IMS TM transaction program: validates and
      *> posts DEPOSIT / WITHDRAW / TRANSFER requests.
      *> Reads a fixed-format record from STDIN, applies business
      *> rules (the part a real IMS/COBOL program would own), and
      *> writes a fixed-format decision record to STDOUT.
      *> The modern gateway (Node.js) is the "hybrid cloud bridge"
      *> that calls this program, mirroring z/OS Connect / IMS
      *> Connect patterns described in the GM job posting.
      *> ============================================================
       IDENTIFICATION DIVISION.
       PROGRAM-ID. TXNENGINE.

       ENVIRONMENT DIVISION.

       DATA DIVISION.
       WORKING-STORAGE SECTION.

       01  WS-INPUT-LINE          PIC X(100).
       01  WS-TXN-TYPE            PIC X(10).
       01  WS-FROM-BALANCE        PIC 9(15).
       01  WS-TO-BALANCE          PIC 9(15).
       01  WS-AMOUNT              PIC 9(15).
       01  WS-RESULT              PIC X(10).
       01  WS-REASON              PIC X(40).
       01  WS-NEW-FROM-BALANCE    PIC 9(15).
       01  WS-NEW-TO-BALANCE      PIC 9(15).
       01  WS-EOF                 PIC X VALUE 'N'.

       PROCEDURE DIVISION.

       MAIN-LOGIC.
           PERFORM READ-INPUT
           PERFORM VALIDATE-AND-POST
           PERFORM WRITE-OUTPUT
           STOP RUN.

       READ-INPUT.
      *> Expected input line format (pipe-delimited, fixed-ish):
      *> TXNTYPE|FROMBAL|TOBAL|AMOUNT
           ACCEPT WS-INPUT-LINE FROM CONSOLE
           UNSTRING WS-INPUT-LINE DELIMITED BY "|"
               INTO WS-TXN-TYPE WS-FROM-BALANCE WS-TO-BALANCE WS-AMOUNT.

       VALIDATE-AND-POST.
           MOVE "POSTED" TO WS-RESULT
           MOVE SPACES TO WS-REASON
           MOVE WS-FROM-BALANCE TO WS-NEW-FROM-BALANCE
           MOVE WS-TO-BALANCE   TO WS-NEW-TO-BALANCE

           IF WS-AMOUNT <= 0
               MOVE "REJECTED" TO WS-RESULT
               MOVE "AMOUNT MUST BE POSITIVE" TO WS-REASON
               GO TO VALIDATE-DONE
           END-IF

           EVALUATE WS-TXN-TYPE
               WHEN "DEPOSIT"
                   ADD WS-AMOUNT TO WS-NEW-TO-BALANCE

               WHEN "WITHDRAW"
                   IF WS-FROM-BALANCE < WS-AMOUNT
                       MOVE "REJECTED" TO WS-RESULT
                       MOVE "INSUFFICIENT FUNDS" TO WS-REASON
                   ELSE
                       SUBTRACT WS-AMOUNT FROM WS-NEW-FROM-BALANCE
                   END-IF

               WHEN "TRANSFER"
                   IF WS-FROM-BALANCE < WS-AMOUNT
                       MOVE "REJECTED" TO WS-RESULT
                       MOVE "INSUFFICIENT FUNDS" TO WS-REASON
                   ELSE
                       SUBTRACT WS-AMOUNT FROM WS-NEW-FROM-BALANCE
                       ADD WS-AMOUNT TO WS-NEW-TO-BALANCE
                   END-IF

               WHEN OTHER
                   MOVE "REJECTED" TO WS-RESULT
                   MOVE "UNKNOWN TXN TYPE" TO WS-REASON
           END-EVALUATE.

       VALIDATE-DONE.
           CONTINUE.

       WRITE-OUTPUT.
      *> Output line format: RESULT|NEWFROMBAL|NEWTOBAL|REASON
           DISPLAY WS-RESULT "|" WS-NEW-FROM-BALANCE "|"
                   WS-NEW-TO-BALANCE "|" WS-REASON.
